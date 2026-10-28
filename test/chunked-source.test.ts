import { describe, expect, it, vi } from 'vitest'
import { ChunkedSource } from '../src/chunked-source.js'

/** A fake remote file whose byte at offset n is n % 251. */
function remoteFile(size: number, chunkSize: number) {
  const fetchChunk = vi.fn(async (index: number) => {
    const start = index * chunkSize
    const length = Math.max(0, Math.min(chunkSize, size - start))
    return Uint8Array.from({ length }, (_, i) => (start + i) % 251)
  })
  return { fetchChunk }
}

const expected = (offset: number, length: number) =>
  Uint8Array.from({ length }, (_, i) => (offset + i) % 251)

describe('ChunkedSource', () => {
  it('reads inside one chunk', async () => {
    const { fetchChunk } = remoteFile(10_000, 1024)
    const source = new ChunkedSource({ size: 10_000, chunkSize: 1024, fetchChunk, readAhead: 0 })
    expect(await source.read(100, 50)).toEqual(expected(100, 50))
    expect(fetchChunk).toHaveBeenCalledTimes(1)
  })

  it('reads across chunk boundaries', async () => {
    const { fetchChunk } = remoteFile(10_000, 1024)
    const source = new ChunkedSource({ size: 10_000, chunkSize: 1024, fetchChunk, readAhead: 0 })
    expect(await source.read(1000, 3000)).toEqual(expected(1000, 3000))
    expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 3])
  })

  it('clamps reads at the end of the file', async () => {
    const { fetchChunk } = remoteFile(5000, 1024)
    const source = new ChunkedSource({ size: 5000, chunkSize: 1024, fetchChunk, readAhead: 0 })
    expect(await source.read(4900, 1000)).toEqual(expected(4900, 100))
    expect(await source.read(5000, 10)).toEqual(new Uint8Array(0))
  })

  it('reassembles the whole file from many small reads', async () => {
    const size = 7777
    const { fetchChunk } = remoteFile(size, 1024)
    const source = new ChunkedSource({ size, chunkSize: 1024, fetchChunk, readAhead: 2 })
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < size; offset += 600) parts.push(await source.read(offset, 600))
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      joined.set(p, at)
      at += p.length
    }
    expect(joined).toEqual(expected(0, size))
  })

  it('shares one download between concurrent reads of a chunk', async () => {
    const { fetchChunk } = remoteFile(10_000, 1024)
    const source = new ChunkedSource({ size: 10_000, chunkSize: 1024, fetchChunk, readAhead: 0 })
    await Promise.all([source.read(0, 10), source.read(10, 10), source.read(500, 10)])
    expect(fetchChunk).toHaveBeenCalledTimes(1)
  })

  it('reads ahead after a read and serves the next read from cache', async () => {
    const { fetchChunk } = remoteFile(10_000, 1024)
    const source = new ChunkedSource({ size: 10_000, chunkSize: 1024, fetchChunk, readAhead: 2 })
    await source.read(0, 100)
    await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(3))
    await source.read(1024, 2048)
    const fetched = fetchChunk.mock.calls.map((c) => c[0])
    // Chunks 1 and 2 came from the cache; the second read queued 3 and 4.
    expect(fetched.filter((i) => i === 1 || i === 2)).toEqual([1, 2])
    await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(5))
  })

  it('drops queued read ahead when the reader seeks elsewhere', async () => {
    // Chunks the reader asks for arrive at once; read ahead downloads are slow.
    const fetchChunk = vi.fn(async (index: number) => {
      if (index !== 0 && index !== 80) await new Promise((r) => setTimeout(r, 20))
      return new Uint8Array(1024)
    })
    const source = new ChunkedSource({
      size: 100 * 1024,
      chunkSize: 1024,
      fetchChunk,
      readAhead: 10,
      concurrency: 1,
    })
    await source.read(0, 10)
    await source.read(80 * 1024, 10)
    await vi.waitFor(() => expect(fetchChunk.mock.calls.length).toBeGreaterThanOrEqual(12))
    const fetched = fetchChunk.mock.calls.map((c) => c[0])
    // Chunk 1 was already downloading; chunks 2..10 never started once the seek arrived.
    expect(fetched.filter((i) => i > 1 && i <= 10)).toEqual([])
    expect(fetched).toContain(81)
  })

  describe('calling off read ahead', () => {
    /** A file whose downloads wait until let through, and report being called off. */
    function slowFile() {
      const aborted: number[] = []
      const waiting = new Map<number, () => void>()
      const fetchChunk = vi.fn(
        (index: number, chunkSize: number, signal?: AbortSignal) =>
          new Promise<Uint8Array>((resolve, reject) => {
            const done = () => resolve(new Uint8Array(chunkSize).fill(index % 251))
            waiting.set(index, done)
            signal?.addEventListener('abort', () => {
              aborted.push(index)
              reject(signal.reason)
            })
          }),
      )
      const release = (index: number) => waiting.get(index)?.()
      return { fetchChunk, aborted, release }
    }

    /** Plays chunk 0 and gets chunk 1 in hand, so chunks 2 and 3 are on their way ahead. */
    async function playingWithTwoAhead(readAhead: number) {
      const file = slowFile()
      const source = new ChunkedSource({
        size: 100 * 1024,
        chunkSize: 1024,
        fetchChunk: file.fetchChunk,
        readAhead,
        concurrency: 2,
      })
      const first = source.read(0, 10)
      file.release(0)
      await first
      await vi.waitFor(() => expect(file.fetchChunk).toHaveBeenCalledTimes(2))
      file.release(1)
      await vi.waitFor(() =>
        expect(file.fetchChunk).toHaveBeenCalledTimes(Math.min(readAhead, 3) + 1),
      )
      return { ...file, source }
    }

    it('calls off read ahead on its way when the reader seeks out of its window', async () => {
      const { source, fetchChunk, aborted, release } = await playingWithTwoAhead(4)
      const seek = source.read(60 * 1024, 10)
      expect(aborted.sort((a, b) => a - b)).toEqual([2, 3])
      release(60)
      expect(await seek).toEqual(new Uint8Array(10).fill(60))
      // The link went to the new place: its read ahead started, the old never resumed.
      await vi.waitFor(() => expect(fetchChunk.mock.calls.map((c) => c[0])).toContain(61))
      release(61)
      await vi.waitFor(() => expect(fetchChunk.mock.calls.map((c) => c[0])).toContain(62))
      expect(fetchChunk.mock.calls.filter((c) => c[0] === 4)).toEqual([])
    })

    it('keeps read ahead that a read is waiting for', async () => {
      const { source, aborted, release } = await playingWithTwoAhead(4)
      // The reader moves on to chunk 2, which is already downloading: nothing is called off.
      const next = source.read(2 * 1024, 10)
      // And a seek elsewhere now calls off chunk 3, but not chunk 2, which that read waits for.
      const other = source.read(50 * 1024, 10)
      expect(aborted).toEqual([3])
      release(2)
      release(50)
      expect(await next).toEqual(new Uint8Array(10).fill(2))
      expect(await other).toEqual(new Uint8Array(10).fill(50))
    })

    it('downloads a called-off chunk again when it is read after all', async () => {
      const { source, fetchChunk, release } = await playingWithTwoAhead(2)
      const seek = source.read(40 * 1024, 10)
      release(40)
      await seek
      const back = source.read(2 * 1024, 10)
      await vi.waitFor(() =>
        expect(fetchChunk.mock.calls.filter((c) => c[0] === 2)).toHaveLength(2),
      )
      release(2)
      expect(await back).toEqual(new Uint8Array(10).fill(2))
    })
  })

  it('evicts the least recently used chunks', async () => {
    const { fetchChunk } = remoteFile(10_000, 1024)
    const source = new ChunkedSource({
      size: 10_000,
      chunkSize: 1024,
      fetchChunk,
      readAhead: 0,
      cacheChunks: 2,
    })
    await source.read(0, 1)
    await source.read(1024, 1)
    await source.read(2048, 1)
    await source.read(0, 1)
    expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 0])
  })

  it('answers only the contiguous part when a chunk comes back short', async () => {
    const fetchChunk = vi.fn(async (index: number) =>
      index === 0 ? new Uint8Array(512).fill(1) : new Uint8Array(1024).fill(2),
    )
    const source = new ChunkedSource({ size: 4096, chunkSize: 1024, fetchChunk, readAhead: 0 })
    const bytes = await source.read(0, 2048)
    expect(bytes.length).toBe(512)
  })

  it('reports a failed download to the reader and retries next time', async () => {
    let fail = true
    const fetchChunk = vi.fn(async () => {
      if (fail) throw new Error('network')
      return new Uint8Array(1024)
    })
    const source = new ChunkedSource({ size: 4096, chunkSize: 1024, fetchChunk, readAhead: 0 })
    await expect(source.read(0, 10)).rejects.toThrow('network')
    fail = false
    expect((await source.read(0, 10)).length).toBe(10)
  })

  describe('side reader', () => {
    it('reads without moving the read ahead', async () => {
      const { fetchChunk } = remoteFile(64 * 1024, 1024)
      const source = new ChunkedSource({
        size: 64 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 3,
      })
      await source.read(0, 10)
      await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(4))
      const side = source.createSideReader()
      expect(await side.read(40 * 1024 + 5, 2000)).toEqual(expected(40 * 1024 + 5, 2000))
      // Only the two chunks it needed; nothing queued after them.
      await new Promise((r) => setTimeout(r, 10))
      expect(fetchChunk.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 40, 41,
      ])
    })

    it('answers from what playback already downloaded', async () => {
      const { fetchChunk } = remoteFile(8192, 1024)
      const source = new ChunkedSource({ size: 8192, chunkSize: 1024, fetchChunk, readAhead: 0 })
      await source.read(0, 2048)
      const side = source.createSideReader()
      expect(await side.read(100, 1500)).toEqual(expected(100, 1500))
      expect(fetchChunk).toHaveBeenCalledTimes(2)
    })

    it("keeps its downloads out of playback's cache", async () => {
      const { fetchChunk } = remoteFile(64 * 1024, 1024)
      const source = new ChunkedSource({
        size: 64 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 0,
        cacheChunks: 2,
      })
      await source.read(0, 2048)
      const side = source.createSideReader(2)
      for (let i = 10; i < 20; i++) await side.read(i * 1024, 10)
      fetchChunk.mockClear()
      // Playback's two chunks are still there.
      await source.read(0, 2048)
      expect(fetchChunk).not.toHaveBeenCalled()
      // And the side reader keeps its last two.
      await side.read(19 * 1024, 10)
      await side.read(18 * 1024, 10)
      expect(fetchChunk).not.toHaveBeenCalled()
    })

    it('shares a download already under way with playback', async () => {
      const { fetchChunk } = remoteFile(8192, 1024)
      const source = new ChunkedSource({ size: 8192, chunkSize: 1024, fetchChunk, readAhead: 0 })
      const side = source.createSideReader()
      const [a, b] = await Promise.all([side.read(3000, 10), source.read(3000, 10)])
      expect(a).toEqual(b)
      expect(fetchChunk).toHaveBeenCalledTimes(1)
      // Playback keeps the chunk it shared.
      await source.read(3000, 10)
      expect(fetchChunk).toHaveBeenCalledTimes(1)
    })
  })

  describe('scheduling', () => {
    /** Downloads that finish when the test lets them through. */
    function heldFile() {
      const waiting = new Map<number, () => void>()
      const fetchChunk = vi.fn(
        (index: number, chunkSize: number, signal?: AbortSignal) =>
          new Promise<Uint8Array>((resolve, reject) => {
            waiting.set(index, () => resolve(new Uint8Array(chunkSize).fill(index % 251)))
            signal?.addEventListener('abort', () => reject(signal.reason))
          }),
      )
      const release = async (index: number) => {
        waiting.get(index)?.()
        await new Promise((r) => setTimeout(r, 0))
      }
      const started = () => fetchChunk.mock.calls.map((c) => c[0])
      return { fetchChunk, release, started }
    }

    it('gives a read playback waits for the link: read ahead starts once it has arrived', async () => {
      const { fetchChunk, release, started } = heldFile()
      const source = new ChunkedSource({
        size: 100 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 4,
        concurrency: 2,
      })
      const read = source.read(50 * 1024, 10)
      expect(started()).toEqual([50])
      await release(50)
      await read
      // Nothing in hand yet: strictly the next chunk first.
      expect(started()).toEqual([50, 51])
      await release(51)
      // A chunk in hand: two overlap.
      expect(started()).toEqual([50, 51, 52, 53])
    })

    it('holds back prefetch while playback waits, and keeps it out of read ahead’s way', async () => {
      const { fetchChunk, release, started } = heldFile()
      const source = new ChunkedSource({
        size: 100 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 2,
        concurrency: 2,
      })
      source.prefetch([0, 99, 1])
      expect(started()).toEqual([0, 99])
      // Playback asks for the header while it is on its way: it waits, nothing new starts.
      const read = source.read(0, 10)
      await release(99)
      expect(started()).toEqual([0, 99])
      await release(0)
      await read
      // Then the rest of the prefetch, before read ahead.
      expect(started()[2]).toBe(1)
    })

    it('lets previews go first while playback has chunks in hand, but never starves it', async () => {
      const { fetchChunk, release, started } = heldFile()
      const source = new ChunkedSource({
        size: 100 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 6,
        concurrency: 2,
      })
      const side = source.createSideReader()
      // Playback with nothing in hand: a preview read does not stop its read ahead.
      const first = source.read(0, 10)
      await release(0)
      await first
      const preview = side.read(80 * 1024, 10)
      expect(started()).toEqual([0, 1, 80])
      await release(1)
      // One chunk in hand now, the preview still waiting: read ahead carries on.
      expect(started()).toContain(2)
      await release(80)
      await preview
      await release(2)
      await release(3)
      // Two in hand: a new preview read pauses the read ahead until it has its chunk.
      const [a, b] = started().slice(-2)
      const before = started().length
      const second = side.read(90 * 1024, 10)
      await release(a!)
      await release(b!)
      expect(started().slice(before)).toEqual([90])
      await release(90)
      await second
      expect(started().length).toBeGreaterThan(before + 1)
    })
  })

  describe('prefetch', () => {
    it('downloads the chunks asked for in order, a couple at a time, then reads come cached', async () => {
      const { fetchChunk } = remoteFile(64 * 1024, 1024)
      const source = new ChunkedSource({
        size: 64 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 0,
        concurrency: 2,
      })
      source.prefetch([0, 63, 1, 99, -1])
      // Two on the link at once; the third follows as one finishes.
      expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([0, 63])
      await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(3))
      expect(fetchChunk.mock.calls[2]![0]).toBe(1)
      expect(await source.read(63 * 1024, 10)).toEqual(expected(63 * 1024, 10))
      expect(await source.read(0, 2048)).toEqual(expected(0, 2048))
      expect(fetchChunk).toHaveBeenCalledTimes(3)
    })

    it('fetches the header, then the end of the file, then the rest of the start', async () => {
      const { fetchChunk } = remoteFile(64 * 1024, 1024)
      const source = new ChunkedSource({ size: 64 * 1024, chunkSize: 1024, fetchChunk })
      source.prefetchStart(3, 2)
      await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(5))
      expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([0, 63, 62, 1, 2])
    })

    it('is not cancelled by a read elsewhere', async () => {
      const { fetchChunk } = remoteFile(64 * 1024, 1024)
      const source = new ChunkedSource({
        size: 64 * 1024,
        chunkSize: 1024,
        fetchChunk,
        readAhead: 2,
      })
      source.prefetch([0, 63])
      await source.read(30 * 1024, 10)
      await vi.waitFor(() => expect(fetchChunk).toHaveBeenCalledTimes(5))
      fetchChunk.mockClear()
      await source.read(0, 10)
      await source.read(63 * 1024, 10)
      // Only read ahead after them was fetched; the prefetched chunks themselves came cached.
      expect(fetchChunk.mock.calls.map((c) => c[0])).not.toContain(0)
      expect(fetchChunk.mock.calls.map((c) => c[0])).not.toContain(63)
    })
  })
})
