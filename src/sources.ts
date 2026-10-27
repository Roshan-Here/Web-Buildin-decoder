// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { ByteSource } from './byte-source.js'
import { ChunkedSource, type ChunkedSourceOptions } from './chunked-source.js'

export interface HttpSourceOptions extends Partial<
  Pick<ChunkedSourceOptions, 'chunkSize' | 'cacheChunks' | 'readAhead' | 'concurrency'>
> {
  /** Extra request headers, for example `Authorization`. */
  headers?: HeadersInit
  /** Sent with every request: `'include'` for cookies on another origin. */
  credentials?: RequestCredentials
  /** The file's size in bytes, when you know it already; saves one request. */
  size?: number
  /**
   * Fetch the first chunks and the last one at once (the header, and the index Matroska and
   * many MP4s keep at the end), so opening costs one round trip instead of several. Default
   * `true`.
   */
  prefetchStart?: boolean
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch
}

/**
 * A file on any HTTP server that answers `Range` requests (most static hosts, S3, R2, GCS and
 * CDNs do), read in chunks with a cache and read ahead.
 *
 * For a file on another origin the server must allow it by CORS and expose `Content-Range`
 * (`Access-Control-Expose-Headers: Content-Range`), unless you pass `size`.
 */
export async function httpSource(
  url: string,
  options: HttpSourceOptions = {},
): Promise<ChunkedSource> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const init = (range: string, signal?: AbortSignal): RequestInit => {
    const headers = new Headers(options.headers)
    headers.set('Range', range)
    return { headers, credentials: options.credentials, signal }
  }

  const size = options.size ?? (await probeSize(url, doFetch, init))
  const source = new ChunkedSource({
    size,
    chunkSize: options.chunkSize,
    cacheChunks: options.cacheChunks,
    readAhead: options.readAhead,
    concurrency: options.concurrency,
    async fetchChunk(index, chunkSize, signal) {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, size) - 1
      const response = await doFetch(url, init(`bytes=${start}-${end}`, signal))
      if (response.status !== 206) {
        // A 200 here is the whole file: the server ignores ranges, and reading on would
        // download it again for every chunk.
        throw new HttpSourceError(
          response.status === 200
            ? 'The server does not answer Range requests'
            : `HTTP ${response.status} for bytes ${start}-${end}`,
          response.status,
        )
      }
      const answered = response.headers.get('Content-Range')?.match(/bytes\s+(\d+)-/)?.[1]
      if (answered !== undefined && Number(answered) !== start) {
        throw new HttpSourceError(`Asked for bytes from ${start}, got from ${answered}`, 206)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      // Some servers send more than the range asked for; keep exactly the chunk.
      return bytes.length > end - start + 1 ? bytes.subarray(0, end - start + 1) : bytes
    },
  })
  if (options.prefetchStart ?? true) source.prefetchStart()
  return source
}

/** A failed HTTP read; `status` is the response's. 404 and 410 never succeed on retry. */
export class HttpSourceError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpSourceError'
    this.status = status
  }
}

/** For `isPermanent`: HTTP answers that will not change on retry (gone, forbidden, not found). */
export function isPermanentHttpError(error: unknown): boolean {
  return (
    error instanceof HttpSourceError &&
    (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410)
  )
}

async function probeSize(
  url: string,
  doFetch: typeof fetch,
  init: (range: string) => RequestInit,
): Promise<number> {
  // Two bytes rather than one: some static servers (sirv, so Vite's dev server among them)
  // read the end `0` in `bytes=0-0` as "no end" and send the whole file.
  const response = await doFetch(url, init('bytes=0-1'))
  // Only the headers are needed; leave the body unread.
  void response.body?.cancel().catch(() => undefined)
  const range = response.headers.get('Content-Range')
  const total = range?.match(/\/(\d+)\s*$/)?.[1]
  if (response.status === 206 && total) return Number(total)
  if (!response.ok && response.status !== 206) {
    throw new HttpSourceError(`HTTP ${response.status} opening the file`, response.status)
  }
  if (response.status === 206) {
    throw new HttpSourceError(
      'The server answered a Range request without a readable Content-Range header. On another ' +
        'origin it must send Access-Control-Expose-Headers: Content-Range, or pass `size`.',
      response.status,
    )
  }
  throw new HttpSourceError('The server does not answer Range requests', response.status)
}

/**
 * A local file, such as one from `<input type="file">` or drag and drop, or any `Blob`. Reads
 * come straight from the disk, so there is nothing to cache.
 */
export function fileSource(file: Blob): ByteSource {
  const source: ByteSource = {
    size: file.size,
    async read(offset, length) {
      if (offset < 0 || offset >= file.size || length <= 0) return new Uint8Array(0)
      const end = Math.min(offset + length, file.size)
      return new Uint8Array(await file.slice(offset, end).arrayBuffer())
    },
    createSideReader: () => source,
  }
  return source
}

/** A file already in memory, for tests and small clips. */
export function bufferSource(bytes: Uint8Array | ArrayBuffer): ByteSource {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const source: ByteSource = {
    size: data.byteLength,
    read: (offset, length) => {
      if (offset < 0 || offset >= data.byteLength || length <= 0)
        return Promise.resolve(new Uint8Array(0))
      return Promise.resolve(data.slice(offset, Math.min(offset + length, data.byteLength)))
    },
    createSideReader: () => source,
  }
  return source
}
