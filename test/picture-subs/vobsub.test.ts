import { describe, expect, it } from 'vitest'
import { readVobSubHeader, VobSubDecoder } from '../../src/picture-subs/vobsub.js'

// prettier-ignore
const PALETTE = [
  '000000', '111111', '222222', '333333', '444444', 'ff0000', '00ff00', '0000ff',
  '888888', '999999', 'aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee', 'ffffff',
]
const idx = new TextEncoder().encode(
  `# VobSub index file, v7\nsize: 720x480\norg: 0, 0\npalette: ${PALETTE.join(', ')}\n`,
)

/**
 * A 4 × 2 subpicture at (10, 20): the top line colours 1, 1, 2, 3 (red, red, green, blue
 * through the header's palette), the bottom line transparent; shown at once, gone after
 * 176 date units (about 2 s).
 */
function spu(): Uint8Array {
  const pixels = [0x96, 0x70, 0x00, 0x00]
  // prettier-ignore
  const first = [
    0x00, 0x00, 0x00, 0x20, // date 0, next sequence at 32
    0x03, 0x76, 0x50, // colours 3, 2, 1, 0 → palette entries 7, 6, 5, 0
    0x04, 0xff, 0xf0, // their opacity: 15, 15, 15, 0
    0x05, 0x00, 0xa0, 0x0d, 0x01, 0x40, 0x15, // x 10 to 13, y 20 to 21
    0x06, 0x00, 0x04, 0x00, 0x06, // the fields' lines start at 4 and 6
    0x01, // start display
    0xff,
  ]
  const second = [0x00, 0xb0, 0x00, 0x20, 0x02, 0xff] // date 176: stop display
  const body = [...pixels, ...first, ...second]
  const size = 4 + body.length
  return Uint8Array.from([size >> 8, size & 255, 0x00, 0x08, ...body])
}

const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

describe('VobSub', () => {
  it('reads the palette and size from the .idx header', () => {
    const header = readVobSubHeader(idx)
    expect([header.width, header.height]).toEqual([720, 480])
    expect(header.palette?.[5]).toEqual([255, 0, 0])
    expect(readVobSubHeader(undefined)).toEqual({ palette: null, width: 0, height: 0 })
  })

  it('draws a subpicture in its colours, where and when it says', () => {
    const decoder = new VobSubDecoder(readVobSubHeader(idx))
    const [event] = decoder.decode(spu(), 10, 0)
    expect(event!.start).toBe(10)
    expect(event!.end).toBeCloseTo(10 + (176 * 1024) / 90_000, 5)
    expect([event!.canvasWidth, event!.canvasHeight]).toEqual([720, 480])
    const picture = event!.pictures[0]!
    expect([picture.x, picture.y, picture.width, picture.height]).toEqual([10, 20, 4, 2])
    expect(pixel(picture.rgba, 4, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixel(picture.rgba, 4, 1, 0)).toEqual([255, 0, 0, 255])
    expect(pixel(picture.rgba, 4, 2, 0)).toEqual([0, 255, 0, 255])
    expect(pixel(picture.rgba, 4, 3, 0)).toEqual([0, 0, 255, 255])
    expect(pixel(picture.rgba, 4, 2, 1)[3]).toBe(0)
  })

  it('takes the end from the container when the stream gives none', () => {
    const data = spu()
    // Make the second sequence's stop a no-op (0xff at once).
    data[data.length - 2] = 0xff
    const [event] = new VobSubDecoder(readVobSubHeader(idx)).decode(data, 5, 3)
    expect(event!.end).toBe(8)
  })

  it('guesses a grey palette when the header has none, and survives damaged data', () => {
    const decoder = new VobSubDecoder()
    const [event] = decoder.decode(spu(), 0, 0)
    expect(event!.pictures[0]!.rgba[3]).toBe(255)
    expect(decoder.decode(Uint8Array.from([0, 9, 0, 200, 1]), 0, 0)).toEqual([])
    expect(decoder.decode(spu().subarray(0, 20), 0, 0)).toEqual([])
  })
})
