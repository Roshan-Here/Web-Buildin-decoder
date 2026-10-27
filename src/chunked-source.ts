// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { ByteSource } from './byte-source.js'

export const DEFAULT_CHUNK_SIZE = 1024 * 1024

export interface ChunkedSourceOptions {
  size: number
  /**
   * Downloads chunk `index`, which starts at `index * chunkSize`. A read ahead that a seek has
   * made pointless is called off through [signal]; the promise may then reject.
   */
  fetchChunk: (index: number, chunkSize: number, signal?: AbortSignal) => Promise<Uint8Array>
  /**
   * Bytes per chunk; 1 MiB by default. Some backends need a particular alignment or a
   * maximum size per request.
   */
  chunkSize?: number
  /** Chunks kept in memory, most recently used first. */
  cacheChunks?: number
  /** Chunks downloaded ahead of the last read, so playback rarely waits. */
  readAhead?: number
  /** Downloads running at once for read ahead; reads the element is waiting for skip the queue. */
  concurrency?: number
}

/**
 * A {@link ByteSource} over a remote file that can only be fetched in fixed, aligned chunks.
 *
 * Reads are answered from an LRU cache of chunks. Every read also queues the chunks after it,
 * and a new read replaces that queue, so a seek stops the old read ahead instead of finishing
 * gigabytes nobody will watch. The read ahead already downloading is called off too, when it
 * is out of the new window: on a seek, the chunk the player now waits for has the connections
 * to itself instead of sharing them with megabytes from where it was. Concurrent requests for
 * one chunk share one download, and a download something is waiting for is never called off.
 */
export class ChunkedSource implements ByteSource {
  readonly size: number
  readonly chunkSize: number
  private readonly fetchChunk: ChunkedSourceOptions['fetchChunk']
  private readonly cacheChunks: number
  private readonly readAhead: number
  private readonly concurrency: number

  private readonly cache = new Map<number, Uint8Array>()
  private readonly inflight = new Map<number, Promise<Uint8Array>>()
  /** Read ahead on its way that no read has asked for yet, and so may be called off. */
  private readonly ahead = new Map<number, AbortController>()
  private queue: number[] = []
  private running = 0

  constructor(options: ChunkedSourceOptions) {
    this.size = options.size
    this.fetchChunk = options.fetchChunk
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.cacheChunks = Math.max(2, options.cacheChunks ?? 32)
    this.readAhead = Math.max(0, options.readAhead ?? 4)
    this.concurrency = Math.max(1, options.concurrency ?? 2)
  }

  get chunkCount(): number {
    return Math.ceil(this.size / this.chunkSize)
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.assemble(offset, length, (i) => this.getChunk(i), true)
  }

  /**
   * A reader for occasional reads elsewhere in the file, such as timeline previews. It answers
   * from playback's cache when it can, but downloads what is missing into a small cache of its
   * own and never touches the read ahead, so scrubbing the timeline neither cancels the
   * download playback is waiting for nor evicts the chunks it is about to play.
   */
  createSideReader(cacheChunks = 8): ByteSource {
    const own = new Map<number, Uint8Array>()
    const limit = Math.max(1, cacheChunks)
    const getChunk = (index: number): Promise<Uint8Array> => {
      const shared = this.cache.get(index)
      if (shared) return Promise.resolve(shared)
      const cached = own.get(index)
      if (cached) {
        own.delete(index)
        own.set(index, cached)
        return Promise.resolve(cached)
      }
      const pending = this.inflight.get(index)
      if (pending) {
        this.ahead.delete(index)
        return pending
      }
      const download = this.fetchChunk(index, this.chunkSize)
        .then((bytes) => {
          own.set(index, bytes)
          while (own.size > limit) {
            const oldest = own.keys().next().value
            if (oldest === undefined) break
            own.delete(oldest)
          }
          return bytes
        })
        .finally(() => this.settled(index, download))
      this.inflight.set(index, download)
      return download
    }
    return {
      size: this.size,
      read: (offset, length) => this.assemble(offset, length, getChunk, false),
    }
  }

  private async assemble(
    offset: number,
    length: number,
    getChunk: (index: number) => Promise<Uint8Array>,
    readAhead: boolean,
  ): Promise<Uint8Array> {
    if (offset < 0 || offset >= this.size || length <= 0) return new Uint8Array(0)
    const end = Math.min(offset + length, this.size)
    const first = Math.floor(offset / this.chunkSize)
    const last = Math.floor((end - 1) / this.chunkSize)

    if (readAhead) this.scheduleReadAhead(first, last + 1)

    const indices: number[] = []
    for (let i = first; i <= last; i++) indices.push(i)
    const chunks = await Promise.all(indices.map((i) => getChunk(i)))

    const out = new Uint8Array(end - offset)
    let written = 0
    for (let n = 0; n < chunks.length; n++) {
      const index = indices[n]!
      const chunk = chunks[n]!
      const chunkStart = index * this.chunkSize
      const from = Math.max(0, offset - chunkStart)
      const to = Math.min(chunk.length, end - chunkStart)
      if (to <= from) break
      out.set(chunk.subarray(from, to), written)
      written += to - from
      // A short chunk before the end of the file: stop here and answer what is contiguous.
      if (chunk.length < this.expectedLength(index)) break
    }
    return written === out.length ? out : out.subarray(0, written)
  }

  /**
   * Starts downloading these chunks now, before anyone reads them: by the time the decoder asks for the header (and,
   * for Matroska or an MP4 with its index at the end, for the end of the file), the bytes are
   * already here instead of each costing a round trip in turn. Unlike read ahead, a new read
   * does not cancel these. Chunks already cached or on their way are skipped.
   */
  prefetch(indices: readonly number[]): void {
    for (const index of indices) {
      if (index < 0 || index >= this.chunkCount) continue
      if (this.cache.has(index) || this.inflight.has(index)) continue
      this.getChunk(index).catch(() => {
        // Best effort; the read that needs this chunk will retry and report.
      })
    }
  }

  /**
   * What any player reads first, fetched now: the first [headChunks] chunks (the header, and
   * an MP4's index when it comes first) and the last [tailChunks] (where Matroska keeps its
   * index, and many MP4s theirs). Fetched together these cost one round trip instead of
   * several in turn.
   */
  prefetchStart(headChunks = 4, tailChunks = 1): void {
    const head = Array.from({ length: Math.max(0, headChunks) }, (_, i) => i)
    const tail = Array.from({ length: Math.max(0, tailChunks) }, (_, i) => this.chunkCount - 1 - i)
    this.prefetch([...head, ...tail])
  }

  /** Forgets cached chunks and pending read ahead, and calls off the read ahead on its way. */
  clear(): void {
    this.cache.clear()
    this.queue = []
    for (const index of [...this.ahead.keys()]) this.cancelAhead(index)
  }

  private expectedLength(index: number): number {
    return Math.min(this.chunkSize, this.size - index * this.chunkSize)
  }

  private getChunk(index: number): Promise<Uint8Array> {
    const cached = this.cache.get(index)
    if (cached) {
      this.cache.delete(index)
      this.cache.set(index, cached)
      return Promise.resolve(cached)
    }
    const pending = this.inflight.get(index)
    // The download may belong to the side reader, which keeps it to itself; playback keeps it too.
    // A read ahead that a read now waits for is no longer anyone's to call off.
    if (pending) {
      this.ahead.delete(index)
      return pending.then((bytes) => {
        if (!this.cache.has(index)) this.remember(index, bytes)
        return bytes
      })
    }

    return this.download(index)
  }

  /** A download into the cache; [signal] can call it off (for read ahead). */
  private download(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const download = this.fetchChunk(index, this.chunkSize, signal)
      .then((bytes) => {
        if (signal?.aborted) throw signal.reason
        this.remember(index, bytes)
        return bytes
      })
      .finally(() => this.settled(index, download))
    this.inflight.set(index, download)
    return download
  }

  /** Forgets a finished download, unless a newer one for the chunk has taken its place. */
  private settled(index: number, download: Promise<Uint8Array>): void {
    if (this.inflight.get(index) === download) this.inflight.delete(index)
  }

  private cancelAhead(index: number): void {
    const controller = this.ahead.get(index)
    if (!controller) return
    this.ahead.delete(index)
    // Gone from the map at once, so a read that wants the chunk again starts a new download.
    this.inflight.delete(index)
    controller.abort(new DOMException('Read ahead no longer needed', 'AbortError'))
  }

  private remember(index: number, bytes: Uint8Array): void {
    this.cache.set(index, bytes)
    while (this.cache.size > this.cacheChunks) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** Read ahead for a read of chunks [first] to [from] - 1: the next [readAhead] chunks. */
  private scheduleReadAhead(first: number, from: number): void {
    const end = Math.min(from + this.readAhead, this.chunkCount)
    // A seek: what was on its way for the old position is called off, freeing the connections.
    for (const index of [...this.ahead.keys()]) {
      if (index < first || index >= end) this.cancelAhead(index)
    }
    const next: number[] = []
    for (let i = from; i < end; i++) {
      if (!this.cache.has(i) && !this.inflight.has(i)) next.push(i)
    }
    this.queue = next
    this.pump()
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const index = this.queue.shift()!
      if (this.cache.has(index) || this.inflight.has(index)) continue
      this.running++
      const controller = new AbortController()
      this.ahead.set(index, controller)
      this.download(index, controller.signal)
        .catch(() => {
          // Read ahead is best effort (or called off); the read that needs this chunk will
          // retry and report.
        })
        .finally(() => {
          if (this.ahead.get(index) === controller) this.ahead.delete(index)
          this.running--
          this.pump()
        })
    }
  }
}
