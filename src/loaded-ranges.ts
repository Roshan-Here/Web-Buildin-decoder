// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/*
 * The loaded part of the timeline. Neither kind of engine knows all of what is downloaded:
 * movi-player reports nothing for a source it is handed (it measures only its own HTTP reader),
 * and the browser's `<video>` only the ten seconds or so it holds itself, while a source's read
 * ahead (`ChunkedSource`) has a minute or more in hand. These put the two together: the built-in
 * decoder reports through them by itself, and a browser engine over a `ByteSource` can too.
 */

/**
 * How far the bytes in hand reach, in seconds of the video: from [time] (the playhead, at byte
 * [from] or a little before it) on to [end], the byte where what is downloaded runs out, at the
 * file's average bitrate. The playhead itself when there is nothing to tell.
 */
export function loadedUntil({
  time,
  duration,
  size,
  from,
  end,
}: {
  time: number
  duration: number
  size: number
  from: number
  end: number
}): number {
  if (!(duration > 0) || !(size > 0) || !Number.isFinite(time)) return time
  if (end >= size) return duration
  const ahead = (Math.max(0, end - from) / size) * duration
  return Math.min(duration, time + ahead)
}

/** [ranges] with [start, end] added, overlapping ranges joined, as `buffered` gives them. */
export function withRange(ranges: TimeRanges | null, start: number, end: number): TimeRanges {
  const pairs: Array<[number, number]> = []
  if (ranges) {
    try {
      for (let i = 0; i < ranges.length; i++) pairs.push([ranges.start(i), ranges.end(i)])
    } catch {
      // Some engines throw while loading; what is downloaded still shows.
    }
  }
  if (end > start) pairs.push([start, end])
  pairs.sort((a, b) => a[0] - b[0])
  const joined: Array<[number, number]> = []
  for (const [s, e] of pairs) {
    const last = joined[joined.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else joined.push([s, e])
  }
  return timeRanges(joined)
}

function timeRanges(pairs: ReadonlyArray<[number, number]>): TimeRanges {
  const at = (i: number, which: 0 | 1) => {
    const pair = pairs[i]
    if (!pair) throw new DOMException('Index out of range', 'IndexSizeError')
    return pair[which]
  }
  return {
    length: pairs.length,
    start: (i: number) => at(i, 0),
    end: (i: number) => at(i, 1),
  } as TimeRanges
}

/**
 * Makes [element]'s `buffered` include what the source has downloaded ahead. [measure] says
 * where the playhead's bytes are and where the downloaded run after them ends, or null to keep
 * the element's own answer. Only the page reads `buffered`; movi-player and the browser never do.
 */
export function reportLoaded(
  element: object,
  measure: (time: number, duration: number) => { from: number; end: number; size: number } | null,
): void {
  const own = findGetter(element, 'buffered')
  Object.defineProperty(element, 'buffered', {
    configurable: true,
    get(this: { currentTime: number; duration: number }) {
      const native = own ? (own.call(this) as TimeRanges) : null
      const time = this.currentTime
      const duration = this.duration
      try {
        const at = measure(time, duration)
        if (!at) return native
        const until = loadedUntil({ time, duration, ...at })
        return withRange(native, time, until)
      } catch {
        return native
      }
    },
  })
}

function findGetter(object: object, name: string): (() => unknown) | null {
  for (let o: object | null = object; o; o = Object.getPrototypeOf(o) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(o, name)
    if (descriptor?.get) return descriptor.get as () => unknown
  }
  return null
}

/**
 * Where the playhead's bytes are, for [reportLoaded]: where it would be at the file's average
 * bitrate, or [from] (the byte the decoder has read to) when the decoder says and that is near
 * it. A decoder's cursor runs a few seconds ahead of the picture, a long way in a small file,
 * and while opening it can be reading an index at the end; then the estimate stands. Null when
 * the length is not known yet.
 */
export function playheadBytes(
  time: number,
  duration: number,
  size: number,
  from?: number,
): number | null {
  if (!(duration > 0) || !(size > 0) || !Number.isFinite(time)) return null
  const estimate = Math.min(size, (time / duration) * size)
  if (from === undefined) return estimate
  // A tenth of the file: more than any bitrate change moves it, less than a jump to the end.
  return Math.abs(from - estimate) <= size * 0.1 ? from : estimate
}
