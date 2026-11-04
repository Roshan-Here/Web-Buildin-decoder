import { describe, expect, it } from 'vitest'
import { DvbDecoder } from '../../src/picture-subs/dvb.js'

/** Bits, most significant first, to bytes. */
function bits(text: string): number[] {
  const clean = text.replace(/\s+/g, '')
  const padded = clean.padEnd(Math.ceil(clean.length / 8) * 8, '0')
  const out: number[] = []
  for (let i = 0; i < padded.length; i += 8) out.push(parseInt(padded.slice(i, i + 8), 2))
  return out
}

function segment(type: number, body: number[]): number[] {
  return [0x0f, type, 0x00, 0x01, body.length >> 8, body.length & 255, ...body]
}

const page = (timeout: number, x: number, y: number) =>
  segment(0x10, [timeout, 0x08, 0x00, 0xff, x >> 8, x & 255, y >> 8, y & 255])

/** Region 0, [width] × 2, [depth] 1 (2-bit) or 2 (4-bit), CLUT 1, filled with code 0. */
const region = (width: number, depth: 1 | 2) =>
  // prettier-ignore
  segment(0x11, [
    0x00, 0x08, 0, width, 0, 2, (2 << 5) | (depth << 2), 0x01, 0x00, 0x00, // region 0
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // object 1 at (0, 0)
  ])

const object = (field: number[], flags = 0x00) =>
  segment(0x13, [0x00, 0x01, flags, field.length >> 8, field.length & 255, 0, 0, ...field])

const end = segment(0x80, [])

const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

describe('DVB subtitles', () => {
  it('draws a 4-bit object through its CLUT, on both fields, for the page time-out', () => {
    // prettier-ignore
    const clut = segment(0x12, [
      0x01, 0x00,
      0x01, 0x41, 235, 128, 128, 0, // white, opaque
      0x02, 0x41, 81, 240, 90, 0x80, // red, half see-through
    ])
    // Four of colour 1, two single 2s, two 0s, then the end of the string.
    const field = [0x11, ...bits('0000 1 0 00 0001  0010 0010  0000 1 1 01  0000 0 000'), 0xf0]
    const packet = Uint8Array.from([
      0x20,
      0x00,
      ...page(5, 100, 200),
      ...region(8, 2),
      ...clut,
      ...object(field),
      ...end,
      0xff,
    ])
    const [event] = new DvbDecoder().decode(packet, 12)
    expect(event).toMatchObject({ start: 12, end: 17, canvasWidth: 720, canvasHeight: 576 })
    const picture = event!.pictures[0]!
    expect([picture.x, picture.y, picture.width, picture.height]).toEqual([100, 200, 8, 2])
    for (const row of [0, 1]) {
      expect(pixel(picture.rgba, 8, 0, row)).toEqual([255, 255, 255, 255])
      const red = pixel(picture.rgba, 8, 4, row)
      expect(red[0]).toBeGreaterThan(230)
      expect(red[1]).toBeLessThan(20)
      expect(red[3]).toBe(127)
      expect(pixel(picture.rgba, 8, 6, row)[3]).toBe(0)
    }
  })

  it('reads 2-bit codes through the default CLUT, and clears with an empty page', () => {
    // One white (1), a run of 3 blacks (2), then the end.
    const field = [0x10, ...bits('01  00 1 000 10  00 0 0 00'), 0xf0]
    const decoder = new DvbDecoder()
    const [shown] = decoder.decode(
      Uint8Array.from([...page(0, 0, 0), ...region(4, 1), ...object(field), ...end]),
      1,
    )
    const picture = shown!.pictures[0]!
    expect(pixel(picture.rgba, 4, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(picture.rgba, 4, 3, 0)).toEqual([0, 0, 0, 255])
    expect(shown!.end).toBeNull()
    const [cleared] = decoder.decode(Uint8Array.from([...segment(0x10, [0, 0x00]), ...end]), 3)
    expect(cleared).toMatchObject({ start: 3, pictures: [] })
  })

  it('places pages on the display the stream defines', () => {
    const display = segment(0x14, [0x00, 0x07, 0x7f, 0x04, 0x37])
    const field = [0x10, ...bits('01 01 01 01'), 0xf0]
    const [event] = new DvbDecoder().decode(
      Uint8Array.from([...display, ...page(0, 0, 0), ...region(4, 1), ...object(field), ...end]),
      0,
    )
    expect([event!.canvasWidth, event!.canvasHeight]).toEqual([1920, 1080])
  })

  it('leaves code 1 alone under the non-modifying colour flag, and survives damage', () => {
    const field = [0x10, ...bits('10 01 10 01'), 0xf0]
    const [event] = new DvbDecoder().decode(
      Uint8Array.from([...page(0, 0, 0), ...region(4, 1), ...object(field, 0x02), ...end]),
      0,
    )
    const picture = event!.pictures[0]!
    expect(pixel(picture.rgba, 4, 0, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(picture.rgba, 4, 1, 0)[3]).toBe(0)
    expect(() =>
      new DvbDecoder().decode(Uint8Array.from([0x0f, 0x11, 0, 1, 0, 40, 1]), 0),
    ).not.toThrow()
  })
})
