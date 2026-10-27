import { describe, expect, it, vi } from 'vitest'
import {
  HttpSourceError,
  bufferSource,
  fileSource,
  httpSource,
  isPermanentHttpError,
} from '../src/sources.js'

const FILE = Uint8Array.from({ length: 5000 }, (_, i) => i % 251)

/** A server that answers Range requests over FILE, the way a static host does. */
function rangeServer(options: { ignoreRanges?: boolean; hideContentRange?: boolean } = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')
    const match = range?.match(/^bytes=(\d+)-(\d+)$/)
    if (!match || options.ignoreRanges) return new Response(FILE.slice(), { status: 200 })
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), FILE.length - 1)
    const headers = new Headers()
    if (!options.hideContentRange)
      headers.set('Content-Range', `bytes ${start}-${end}/${FILE.length}`)
    return new Response(FILE.slice(start, end + 1), { status: 206, headers })
  })
}

describe('httpSource', () => {
  it('learns the size from Content-Range and reads any range', async () => {
    const fetch = rangeServer()
    const source = await httpSource('https://example.test/a.mkv', {
      fetch,
      chunkSize: 1024,
      prefetchStart: false,
    })
    expect(source.size).toBe(5000)
    const bytes = await source.read(1000, 100)
    expect(Array.from(bytes)).toEqual(Array.from(FILE.slice(1000, 1100)))
  })

  it('asks for whole aligned chunks, the last one cut at the end of the file', async () => {
    const fetch = rangeServer()
    const source = await httpSource('https://example.test/a.mkv', {
      fetch,
      size: 5000,
      chunkSize: 1024,
      readAhead: 0,
      prefetchStart: false,
    })
    await source.read(4990, 10)
    const ranges = fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Range'))
    expect(ranges).toEqual(['bytes=4096-4999'])
  })

  it('sends the headers it is given', async () => {
    const fetch = rangeServer()
    await httpSource('https://example.test/a.mkv', {
      fetch,
      headers: { Authorization: 'Bearer x' },
      prefetchStart: false,
    })
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer x')
  })

  it('refuses a server that ignores ranges', async () => {
    await expect(
      httpSource('https://example.test/a.mkv', { fetch: rangeServer({ ignoreRanges: true }) }),
    ).rejects.toThrow('does not answer Range requests')
  })

  it('explains a Content-Range header hidden by CORS', async () => {
    await expect(
      httpSource('https://example.test/a.mkv', { fetch: rangeServer({ hideContentRange: true }) }),
    ).rejects.toThrow('Access-Control-Expose-Headers')
  })

  it('reports a missing file as permanent', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }))
    const error = await httpSource('https://example.test/gone.mkv', { fetch }).catch((e) => e)
    expect(error).toBeInstanceOf(HttpSourceError)
    expect(isPermanentHttpError(error)).toBe(true)
    expect(isPermanentHttpError(new HttpSourceError('busy', 503))).toBe(false)
  })
})

describe('fileSource and bufferSource', () => {
  it('read slices and answer empty at the end', async () => {
    for (const source of [fileSource(new Blob([FILE])), bufferSource(FILE)]) {
      expect(source.size).toBe(5000)
      expect(Array.from(await source.read(10, 3))).toEqual([10, 11, 12])
      expect((await source.read(4998, 10)).length).toBe(2)
      expect((await source.read(5000, 10)).length).toBe(0)
      expect(source.createSideReader?.()).toBe(source)
    }
  })
})
