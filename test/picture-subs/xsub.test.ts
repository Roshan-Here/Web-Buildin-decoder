import { describe, expect, it } from 'vitest'
import { XSubDecoder } from '../../src/picture-subs/xsub.js'

/**
 * A 4 × 2 XSUB picture at (5, 6), shown from 1:02.5 to 1:04: the even line colour 1 then
 * colour 2 to its end, the odd line all colour 3.
 */
function packet(times = '[00:01:02.500-00:01:04.000]'): Uint8Array {
  const le16 = (v: number) => [v & 255, v >> 8]
  // prettier-ignore
  const header = [
    ...le16(4), ...le16(2), ...le16(5), ...le16(6), ...le16(8), ...le16(7), ...le16(0),
    0, 0, 0, // colour 0: the background, never shown
    255, 0, 0, // colour 1: red
    0, 255, 0, // colour 2: green
    0, 0, 255, // colour 3: blue
  ]
  // Even line: a run of 1 in colour 1 (2 bits of run, as its byte starts high, and 2 of colour),
  // then "to the end of the line" (14 bits of 0) in colour 2; odd line: all colour 3.
  const lines = [0b0101_0000, 0b0000_0000, 0b0010_0000, 0b0000_0000, 0b0000_0011]
  return Uint8Array.from([...new TextEncoder().encode(times), ...header, ...lines])
}

const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

describe('XSUB', () => {
  it('shows a picture at its own times, its even lines then its odd ones', () => {
    const [event] = new XSubDecoder().decode(packet())
    expect(event).toMatchObject({ start: 62.5, end: 64 })
    const picture = event!.pictures[0]!
    expect([picture.x, picture.y, picture.width, picture.height]).toEqual([5, 6, 4, 2])
    expect(pixel(picture.rgba, 4, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixel(picture.rgba, 4, 3, 0)).toEqual([0, 255, 0, 255])
    expect(pixel(picture.rgba, 4, 2, 1)).toEqual([0, 0, 255, 255])
  })

  it('ignores packets without its time stamp, or cut short', () => {
    expect(new XSubDecoder().decode(packet('[00:01:02.500 00:01:04.000]'))).toEqual([])
    expect(new XSubDecoder().decode(packet().subarray(0, 30))).toEqual([])
  })
})
