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
  /**
   * The most downloads on the link at once for work nobody waits for yet (prefetch and read
   * ahead). Two keep the link busy through each request's round trip; more only split the
   * bandwidth, so the next chunk playback needs arrives later. Reads someone waits for always
   * start at once.
   */
  concurrency?: number
}

/** A read waiting for a chunk: playback's, or the side reader's (timeline previews). */
type Waiter = 'playback' | 'side'

/**
 * A {@link ByteSource} over a remote file that can only be fetched in fixed, aligned chunks.
 *
 * Reads are answered from an LRU cache of chunks. Downloads are scheduled by who needs them,
 * because every download in flight shares one link: a 1 MiB chunk fetched beside five others
 * takes six times as long. So:
 *
 * - A read someone is waiting for starts its download at once.
 * - Work nobody waits for yet (the start of the file fetched on opening, then read ahead after
 *   each read) runs at most [concurrency] downloads at a time, in order, nearest first, and
 *   none of it starts while playback waits for a chunk: after a seek, the chunk the picture
 *   needs gets the link to itself, then the read ahead follows it, one chunk at a time until
 *   playback has one in hand.
 * - Previews (the side reader) wait their turn the same way, but read ahead pauses for them only
 *   while playback has some chunks in hand, so hovering the timeline never starves the video.
 *
 * Every read queues the chunks after it, and a new read replaces that queue, so a seek stops
 * the old read ahead instead of finishing gigabytes nobody will watch; the read ahead already
 * downloading is called off too when it falls outside the new window. Concurrent requests for
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
  /** Chunks reads are waiting for, by whose reads, with how many reads waiting. */
  private readonly waiting = new Map<number, Map<Waiter, number>>()
  /** Asked for by prefetch: not cancelled by reads, and fetched before read ahead. */
  private prefetchQueue: number[] = []
  private aheadQueue: number[] = []
  /** The chunk after playback's last read: where the chunks it has in hand are counted from. */
  private playhead = 0

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
        return this.waitFor(index, 'side', pending)
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
      return this.waitFor(index, 'side', download)
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

    const indices: number[] = []
    for (let i = first; i <= last; i++) indices.push(i)
    // The chunks asked for first, so the read ahead queued after them waits for them.
    const pending = indices.map((i) => getChunk(i))
    if (readAhead) {
      this.playhead = last + 1
      this.scheduleReadAhead(first, last + 1)
    }
    const chunks = await Promise.all(pending)

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
   * Fetches these chunks before anyone reads them, as soon as a video is opened: by the time the decoder asks for the header (and, for Matroska
   * or an MP4 with its index at the end, for the end of the file), the bytes are here or on
   * their way. They are fetched in the order given, before any read ahead, a few at a time
   * (see [concurrency]); unlike read ahead, a new read does not cancel them. Chunks already
   * cached or on their way are skipped.
   */
  prefetch(indices: readonly number[]): void {
    for (const index of indices) {
      if (index < 0 || index >= this.chunkCount) continue
      if (this.cache.has(index) || this.inflight.has(index)) continue
      if (!this.prefetchQueue.includes(index)) this.prefetchQueue.push(index)
    }
    this.pump()
  }

  /**
   * What any player reads first: the header, then the end of the file (where Matroska keeps
   * its index, and many MP4s theirs; [tailChunks] of it), then the rest of the first
   * [headChunks] chunks, where playback from the start begins.
   */
  prefetchStart(headChunks = 4, tailChunks = 1): void {
    const head = Array.from({ length: Math.max(0, headChunks) }, (_, i) => i)
    const tail = Array.from({ length: Math.max(0, tailChunks) }, (_, i) => this.chunkCount - 1 - i)
    this.prefetch([...head.slice(0, 1), ...tail, ...head.slice(1)])
  }

  /** Forgets cached chunks and queued work, and calls off the read ahead on its way. */
  clear(): void {
    this.cache.clear()
    this.aheadQueue = []
    this.prefetchQueue = []
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
      return this.waitFor(
        index,
        'playback',
        pending.then((bytes) => {
          if (!this.cache.has(index)) this.remember(index, bytes)
          return bytes
        }),
      )
    }
    this.prefetchQueue = this.prefetchQueue.filter((i) => i !== index)
    return this.waitFor(index, 'playback', this.download(index))
  }

  /** Counts a read as waiting for [index] until [promise] settles, for the scheduling. */
  private waitFor(index: number, who: Waiter, promise: Promise<Uint8Array>): Promise<Uint8Array> {
    const counts = this.waiting.get(index) ?? new Map<Waiter, number>()
    counts.set(who, (counts.get(who) ?? 0) + 1)
    this.waiting.set(index, counts)
    const done = () => {
      const n = (counts.get(who) ?? 1) - 1
      if (n > 0) counts.set(who, n)
      else counts.delete(who)
      if (counts.size === 0 && this.waiting.get(index) === counts) this.waiting.delete(index)
      this.pump()
    }
    return promise.finally(done)
  }

  /** A download into the cache; [signal] can call it off (for read ahead). */
  private download(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const download = this.fetchChunk(index, this.chunkSize, signal)
      .then((bytes) => {
        if (signal?.aborted) throw signal.reason
        this.remember(index, bytes)
        return bytes
      })
      .finally(() => {
        this.settled(index, download)
        this.pump()
      })
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
    // A seek: what was on its way for the old position is called off, freeing the link.
    for (const index of [...this.ahead.keys()]) {
      if (index < first || index >= end) this.cancelAhead(index)
    }
    const next: number[] = []
    for (let i = from; i < end; i++) {
      if (!this.cache.has(i) && !this.inflight.has(i)) next.push(i)
    }
    this.aheadQueue = next
    this.pump()
  }

  /** Chunks playback has in hand past its last read, without a gap. */
  private inHand(): number {
    let n = 0
    while (this.cache.has(this.playhead + n)) n++
    return n
  }

  /** Whether work nobody waits for has to give the link to a read that is waiting. */
  private yieldToReads(): boolean {
    let side = false
    for (const counts of this.waiting.values()) {
      if (counts.has('playback')) return true
      if (counts.has('side')) side = true
    }
    // Previews go first only while playback has something to play meanwhile.
    return side && this.inHand() >= 2
  }

  private pump(): void {
    while (!this.yieldToReads()) {
      const fromPrefetch = this.prefetchQueue.length > 0
      // Read ahead with nothing in hand fetches strictly one chunk at a time, so the next one
      // playback needs is not slowed by the one after it; with a chunk in hand, two overlap.
      const limit = fromPrefetch || this.inHand() >= 1 ? this.concurrency : 1
      if (this.inflight.size >= limit) return
      const index = fromPrefetch ? this.prefetchQueue.shift() : this.aheadQueue.shift()
      if (index === undefined) return
      if (this.cache.has(index) || this.inflight.has(index)) continue
      if (fromPrefetch) {
        this.download(index).catch(() => {
          // Best effort; the read that needs this chunk will retry and report.
        })
        continue
      }
      const controller = new AbortController()
      this.ahead.set(index, controller)
      this.download(index, controller.signal)
        .catch(() => {
          // Read ahead is best effort (or called off); the read that needs this chunk will
          // retry and report.
        })
        .finally(() => {
          if (this.ahead.get(index) === controller) this.ahead.delete(index)
        })
    }
  }
}
