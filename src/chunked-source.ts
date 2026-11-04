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
  /**
   * Chunks kept in memory: those nearest where playback is are the last to go. Left out, it
   * holds the read ahead and what is kept behind and away (see `fitReadAhead`), at least 32.
   */
  cacheChunks?: number
  /**
   * Chunks downloaded ahead of the last read, so playback rarely waits. Left out, it starts at 4
   * and becomes about a minute and a half of the video once its length is known (the built-in
   * decoder calls `fitReadAhead` when it opens the file); given, it stays as given.
   */
  readAhead?: number
  /**
   * Chunks behind the last read kept in memory before any ahead of it go, so a skip back to
   * what was just played is answered at once instead of downloaded again. Left out, none until
   * `fitReadAhead` makes it a minute of the video; given, it stays as given.
   */
  keepBehind?: number
  /**
   * Chunks before the last read downloaded once the read ahead is done, when they are not here
   * (after a seek, or opening part way in), so a skip back from there is instant too. At most
   * [keepBehind]. Left out, none until `fitReadAhead` makes it half a minute.
   */
  readBehind?: number
  /**
   * Chunks kept from where playback was before a jump elsewhere in the file (back to the
   * start, far along the timeline), before anything else farther off, so going back there is
   * instant. Left out, none until `fitReadAhead` makes it a minute.
   */
  keepAway?: number
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
 * Reads are answered from a cache of chunks that keeps what is nearest where playback is: the
 * read ahead, [keepBehind] chunks behind it (what was just played), [keepAway] from where
 * playback was before a jump, and the start and end of the file; the farthest go first, so a
 * skip back is as quick as one forward. Downloads are scheduled by who needs them,
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
  private cacheChunks: number
  private readAhead: number
  private keepBehind: number
  private readBehind: number
  private keepAway: number
  /** Which sizes follow the video's length, rather than stay as given. */
  private readonly fits: {
    ahead: boolean
    cache: boolean
    keepBehind: boolean
    readBehind: boolean
    keepAway: boolean
  }
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
  /** The first chunk of playback's last read: what the cache keeps nearest. */
  private at = 0
  /** Where the read ahead reached before the last read: kept too after a small skip back. */
  private reached = 0
  /** Where playback was before its last jump out of what is kept, while that is kept. */
  private previous: number | null = null

  constructor(options: ChunkedSourceOptions) {
    this.size = options.size
    this.fetchChunk = options.fetchChunk
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.cacheChunks = Math.max(2, options.cacheChunks ?? 32)
    this.readAhead = Math.max(0, options.readAhead ?? 4)
    this.keepBehind = Math.max(0, options.keepBehind ?? 0)
    this.readBehind = Math.max(0, options.readBehind ?? 0)
    this.keepAway = Math.max(0, options.keepAway ?? 0)
    this.fits = {
      ahead: options.readAhead === undefined,
      cache: options.cacheChunks === undefined,
      keepBehind: options.keepBehind === undefined,
      readBehind: options.readBehind === undefined,
      keepAway: options.keepAway === undefined,
    }
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

  /**
   * Sizes what is kept by time once the video's length is known, as streaming apps keep it, as
   * far as the device's memory allows (`aheadCap`):
   *
   * - about [seconds] (90) read ahead, so a skip forward of ten or thirty seconds lands on bytes
   *   already here and a weak patch of signal is ridden out;
   * - [behindSeconds] (60) of what was just played kept, and [readBehindSeconds] (30) before
   *   where playback started fetched once the read ahead is done, so a skip back is as quick;
   * - [awaySeconds] (60) kept from where playback was before a jump, so going back is instant.
   *
   * Behind and away each take at most half of what is kept ahead. The cache grows to hold it
   * all. Sizes given to the constructor stay as given.
   */
  fitReadAhead(durationSeconds: number, options: FitReadAheadOptions = {}): void {
    const sized = { chunkSize: this.chunkSize, ...options }
    const half = Math.ceil((options.maxMiB ?? aheadCap()) / 2)
    const behind = (seconds: number) =>
      behindChunks(this.size, durationSeconds, { ...sized, seconds, maxMiB: half })
    if (this.fits.ahead) this.readAhead = readAheadChunks(this.size, durationSeconds, sized)
    if (this.fits.keepBehind) this.keepBehind = behind(options.behindSeconds ?? BEHIND_SECONDS)
    if (this.fits.readBehind)
      this.readBehind = behind(options.readBehindSeconds ?? READ_BEHIND_SECONDS)
    if (this.fits.keepAway) this.keepAway = behind(options.awaySeconds ?? AWAY_SECONDS)
    if (this.fits.cache)
      this.cacheChunks = Math.max(
        32,
        this.readAhead + this.keepBehind + this.keepAway + SPARE_CHUNKS,
      )
  }

  /** How many chunks are read ahead of playback now. */
  get readAheadChunks(): number {
    return this.readAhead
  }

  bufferedEnd(offset: number): number {
    if (offset >= this.size) return this.size
    let index = Math.floor(Math.max(0, offset) / this.chunkSize)
    while (index < this.chunkCount && this.cache.has(index)) index++
    return Math.max(offset, Math.min(this.size, index * this.chunkSize))
  }

  /**
   * Every stretch of the file downloaded, as [start, end) byte ranges in order: what is ahead
   * of the playhead, what was just played, and what is kept from where playback was before.
   */
  bufferedRuns(): Array<[number, number]> {
    const runs: Array<[number, number]> = []
    for (const index of [...this.cache.keys()].sort((a, b) => a - b)) {
      const start = index * this.chunkSize
      const end = Math.min(this.size, start + this.chunkSize)
      const last = runs[runs.length - 1]
      if (last && last[1] === start) last[1] = end
      else runs.push([start, end])
    }
    return runs
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
      const victim = this.farthest(index)
      if (victim === undefined) break
      this.cache.delete(victim)
    }
  }

  /**
   * The cached chunk to let go of first: the one farthest outside what is kept around the
   * playhead (from [keepBehind] chunks behind it to the end of the read ahead, or as far as it
   * had reached before a small skip back), then what is kept from where playback was before a
   * jump; with everything kept, the one farthest behind. The first and last chunks of the file
   * (the header, and the index Matroska and many MP4s keep at the end, which a decoder reads
   * again when it opens the file again) go only when nothing else can, and [keep], the chunk
   * just stored, never unless it is the only one.
   */
  private farthest(keep: number): number | undefined {
    const low = this.at - this.keepBehind
    const high = Math.max(this.at + this.readAhead, this.reached)
    const away = this.previous
    const awayLow = away === null ? 0 : away - Math.min(4, this.keepAway)
    const awayHigh = away === null ? -1 : away + this.keepAway
    const last = this.chunkCount - 1
    let victim: number | undefined
    let worst = Number.NEGATIVE_INFINITY
    for (const index of this.cache.keys()) {
      if (index === keep || index === 0 || index === last) continue
      const distance =
        index >= low && index <= high
          ? -(index - low) / (high - low + 1) - 1
          : index >= awayLow && index <= awayHigh
            ? -(index - awayLow) / (awayHigh - awayLow + 1) / 2
            : index < low
              ? low - index + 0.5
              : index - high
      if (distance > worst) {
        worst = distance
        victim = index
      }
    }
    if (victim !== undefined) return victim
    for (const index of [0, last]) if (index !== keep && this.cache.has(index)) return index
    return this.cache.size > 0 ? keep : undefined
  }

  /**
   * Read ahead for a read of chunks [first] to [from] - 1: the next [readAhead] chunks, then the
   * [readBehind] before [first] that are not here, nearest first.
   */
  private scheduleReadAhead(first: number, from: number): void {
    const was = this.at
    const end = Math.min(from + this.readAhead, this.chunkCount)
    // A jump out of what is kept (not playing on, nor a skip within it): where playback was is
    // kept, with what was downloaded there.
    const jumped =
      first < was - this.keepBehind || first > Math.max(was + this.readAhead, this.reached)
    if (jumped && this.keepAway > 0) this.previous = was
    // A small skip back keeps what the read ahead had reached, and lets it finish.
    this.reached = jumped || first > was ? end : Math.max(end, this.reached)
    this.at = first
    // Never fetched behind farther than is kept there.
    const start = Math.max(0, first - Math.min(this.readBehind, this.keepBehind))
    // A seek: what was on its way for the old position is called off, freeing the link.
    for (const index of [...this.ahead.keys()]) {
      if (index < start || index >= this.reached) this.cancelAhead(index)
    }
    const next: number[] = []
    for (let i = from; i < end; i++) {
      if (!this.cache.has(i) && !this.inflight.has(i)) next.push(i)
    }
    for (let i = first - 1; i >= start; i--) {
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

const AHEAD_SECONDS = 90
/** Fitted sizes behind the playhead and away from it, in seconds of the video. */
const BEHIND_SECONDS = 60
const READ_BEHIND_SECONDS = 30
const AWAY_SECONDS = 60
const BEHIND_MIN = 12
/** Room for the start and the end of the file, fetched on opening, and a read in flight. */
const SPARE_CHUNKS = 8
/** For a file whose length is not known, in 1 MiB chunks. */
const AHEAD_UNKNOWN = 24
const AHEAD_MIN = 12
const AHEAD_MAX_PHONE = 40
const AHEAD_MAX_SMALL = 64
const AHEAD_MAX = 128
const MiB = 1024 * 1024

export interface FitReadAheadOptions {
  /** Seconds of the video to keep downloaded ahead; 90 by default. */
  seconds?: number
  /** Seconds of what was just played to keep; 60 by default. */
  behindSeconds?: number
  /** Seconds before where playback started to fetch; 30 by default. */
  readBehindSeconds?: number
  /** Seconds kept from where playback was before a jump; 60 by default. */
  awaySeconds?: number
  /** The most read ahead, in MiB; by default what the device can hold (`aheadCap`). */
  maxMiB?: number
}

/**
 * How much read ahead (in MiB) this device can hold: by its memory where the browser says
 * (`navigator.deviceMemory`: 40 MiB at 2 GB or less, 64 at 4 GB, else 128), and where it does
 * not (Safari, Firefox), 40 on a touch screen and 128 otherwise.
 */
export function aheadCap(
  nav: { deviceMemory?: number; maxTouchPoints?: number } | undefined = globalThis.navigator,
): number {
  const memory = nav?.deviceMemory
  if (typeof memory === 'number' && memory > 0) {
    if (memory <= 2) return AHEAD_MAX_PHONE
    if (memory <= 4) return AHEAD_MAX_SMALL
    return AHEAD_MAX
  }
  return (nav?.maxTouchPoints ?? 0) > 0 ? AHEAD_MAX_PHONE : AHEAD_MAX
}

/**
 * How many chunks to keep downloading ahead of playback: about [seconds] of the video at its
 * average bitrate, so a 4K film keeps as many seconds in hand as a phone recording, at least
 * 12 MiB and at most [maxMiB].
 */
export function readAheadChunks(
  size: number,
  durationSeconds: number,
  {
    seconds = AHEAD_SECONDS,
    maxMiB = aheadCap(),
    chunkSize = DEFAULT_CHUNK_SIZE,
  }: FitReadAheadOptions & { chunkSize?: number } = {},
): number {
  const toChunks = (mib: number) => Math.max(1, Math.ceil((mib * MiB) / chunkSize))
  const cap = toChunks(maxMiB)
  if (!(durationSeconds > 0) || !(size > 0)) return Math.min(cap, toChunks(AHEAD_UNKNOWN))
  const wanted = Math.ceil(((size / durationSeconds) * seconds) / chunkSize)
  return Math.min(cap, Math.max(toChunks(AHEAD_MIN), wanted))
}

/**
 * How many chunks to keep (or fetch) behind the playhead, or away from it: [seconds] of the
 * video at its average bitrate, at least 12 MiB and at most [maxMiB] (by default half of what
 * the device keeps ahead).
 */
export function behindChunks(
  size: number,
  durationSeconds: number,
  {
    seconds = BEHIND_SECONDS,
    maxMiB = Math.ceil(aheadCap() / 2),
    chunkSize = DEFAULT_CHUNK_SIZE,
  }: { seconds?: number; maxMiB?: number; chunkSize?: number } = {},
): number {
  const toChunks = (mib: number) => Math.max(1, Math.ceil((mib * MiB) / chunkSize))
  const cap = toChunks(maxMiB)
  if (!(durationSeconds > 0) || !(size > 0)) return Math.min(cap, toChunks(AHEAD_UNKNOWN))
  const wanted = Math.ceil(((size / durationSeconds) * seconds) / chunkSize)
  return Math.min(cap, Math.max(toChunks(BEHIND_MIN), wanted))
}
