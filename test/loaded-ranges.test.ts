import { describe, expect, it } from 'vitest'
import { loadedUntil, playheadBytes, reportLoaded, withRange } from '../src/loaded-ranges.js'

const pairs = (r: TimeRanges | null) =>
  r ? Array.from({ length: r.length }, (_, i) => [r.start(i), r.end(i)]) : null

describe('loaded ranges', () => {
  it('turns the bytes in hand into seconds at the average bitrate', () => {
    // 100 MB over 100 s: 10 MB ahead of byte 30 MB is 10 s ahead of the playhead.
    expect(loadedUntil({ time: 30, duration: 100, size: 100e6, from: 30e6, end: 40e6 })).toBe(40)
    // Downloaded to the end: all of it.
    expect(loadedUntil({ time: 30, duration: 100, size: 100e6, from: 30e6, end: 100e6 })).toBe(100)
    // Nothing known.
    expect(loadedUntil({ time: 30, duration: 0, size: 100e6, from: 0, end: 0 })).toBe(30)
  })

  it('joins what the element holds with what is downloaded', () => {
    const native = withRange(null, 20, 30)
    expect(pairs(withRange(native, 25, 70))).toEqual([[20, 70]])
    expect(pairs(withRange(native, 50, 60))).toEqual([
      [20, 30],
      [50, 60],
    ])
    expect(pairs(withRange(native, 40, 40))).toEqual([[20, 30]])
    expect(() => withRange(null, 0, 1).end(1)).toThrow()
  })

  it('takes the decoder’s place only when it is near the playhead', () => {
    expect(playheadBytes(50, 100, 1000)).toBe(500)
    expect(playheadBytes(50, 100, 1000, 530)).toBe(530)
    // Reading the index at the end while opening, or far ahead in a small file: the estimate.
    expect(playheadBytes(0, 100, 1000, 990)).toBe(0)
    expect(playheadBytes(10, 100, 1000, 400)).toBe(100)
    expect(playheadBytes(0, 0, 1000, 0)).toBeNull()
  })

  it('reports through the element’s own buffered, which it keeps when nothing is known', () => {
    class Element {
      currentTime = 10
      duration = 100
      get buffered(): TimeRanges {
        return withRange(null, 8, 15)
      }
    }
    const element = new Element()
    let known = true
    reportLoaded(element, () => (known ? { from: 100, end: 400, size: 1000 } : null))
    expect(pairs(element.buffered)).toEqual([[8, 40]])
    known = false
    expect(pairs(element.buffered)).toEqual([[8, 15]])
  })
})
