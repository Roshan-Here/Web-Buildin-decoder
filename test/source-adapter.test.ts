import { describe, expect, it, vi } from 'vitest'
import { ByteSourceAdapter } from '../src/source-adapter.js'

const instant = () => Promise.resolve()

function fileOf(size: number) {
  return {
    size,
    read: vi.fn(async (offset: number, length: number) =>
      Uint8Array.from({ length: Math.min(length, size - offset) }, (_, i) => (offset + i) % 256),
    ),
  }
}

describe('ByteSourceAdapter', () => {
  it('reads bytes as an ArrayBuffer and tracks the position', async () => {
    const adapter = new ByteSourceAdapter(fileOf(1000), { key: 'k', sleep: instant })
    const buffer = await adapter.read(10, 4)
    expect(Array.from(new Uint8Array(buffer))).toEqual([10, 11, 12, 13])
    expect(adapter.getPosition()).toBe(14)
    expect(await adapter.getSize()).toBe(1000)
    expect(adapter.getKey()).toBe('k')
  })

  it('answers an empty buffer only at the end of the file', async () => {
    const adapter = new ByteSourceAdapter(fileOf(100), { key: 'k', sleep: instant })
    expect((await adapter.read(100, 10)).byteLength).toBe(0)
    expect((await adapter.read(95, 10)).byteLength).toBe(5)
  })

  it('retries an empty read before the end, since FFmpeg would take it as the end', async () => {
    const source = fileOf(100)
    source.read.mockResolvedValueOnce(new Uint8Array(0))
    const adapter = new ByteSourceAdapter(source, { key: 'k', sleep: instant })
    expect((await adapter.read(0, 10)).byteLength).toBe(10)
    expect(source.read).toHaveBeenCalledTimes(2)
  })

  it('retries transient failures with growing delays, reporting that it is refused meanwhile', async () => {
    const source = fileOf(100)
    source.read
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
    const delays: number[] = []
    let refusingDuringRetry = false
    const adapter = new ByteSourceAdapter(source, {
      key: 'k',
      retryDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms)
        refusingDuringRetry ||= adapter.isRefusing()
      },
    })
    expect((await adapter.read(0, 10)).byteLength).toBe(10)
    expect(delays).toEqual([100, 200])
    expect(refusingDuringRetry).toBe(true)
    expect(adapter.isRefusing()).toBe(false)
  })

  it('gives up after the last attempt with the last error', async () => {
    const source = fileOf(100)
    source.read.mockRejectedValue(new Error('offline'))
    const adapter = new ByteSourceAdapter(source, { key: 'k', attempts: 3, sleep: instant })
    await expect(adapter.read(0, 10)).rejects.toThrow('offline')
    expect(source.read).toHaveBeenCalledTimes(3)
    expect(adapter.getFatalError()).toBeNull()
  })

  it('stops at once on a permanent failure and remembers it', async () => {
    const source = fileOf(100)
    source.read.mockRejectedValue(new Error('gone'))
    const adapter = new ByteSourceAdapter(source, {
      key: 'k',
      sleep: instant,
      isPermanent: (e) => e instanceof Error && e.message === 'gone',
    })
    await expect(adapter.read(0, 10)).rejects.toThrow('gone')
    expect(source.read).toHaveBeenCalledTimes(1)
    expect(adapter.getFatalError()?.message).toBe('gone')
    await expect(adapter.read(20, 10)).rejects.toThrow('gone')
  })

  it('refuses reads after close', async () => {
    const adapter = new ByteSourceAdapter(fileOf(100), { key: 'k', sleep: instant })
    adapter.close()
    await expect(adapter.read(0, 1)).rejects.toThrow('closed')
  })

  it('returns its own copy, not a view of the cache', async () => {
    const shared = new Uint8Array(64).fill(7)
    const source = { size: 64, read: vi.fn(async () => shared.subarray(8, 16)) }
    const adapter = new ByteSourceAdapter(source, { key: 'k', sleep: instant })
    const buffer = await adapter.read(8, 8)
    expect(buffer.byteLength).toBe(8)
    expect(buffer).not.toBe(shared.buffer)
  })
})
