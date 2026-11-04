import { describe, expect, it } from 'vitest'
import { decodeRle, PgsDecoder } from '../../src/picture-subs/pgs.js'
import { boxPixels, encodeRle, writeDisplaySet, writeSup } from './pgs-writer.js'

const palette = new Map([
  [0, { r: 0, g: 0, b: 0, a: 0 }],
  [1, { r: 255, g: 220, b: 0, a: 255 }],
  [2, { r: 0, g: 0, b: 0, a: 255 }],
  [3, { r: 255, g: 255, b: 255, a: 128 }],
])

const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

const near = (actual: number[], expected: number[]) =>
  actual.every((v, i) => Math.abs(v - expected[i]!) <= 2)

describe('PGS run-length coding', () => {
  it('reads back what was written, long runs and single pixels alike', () => {
    const width = 300
    const height = 5
    const pixels = new Uint8Array(width * height)
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 97 < 70 ? 0 : (i % 7) + 1
    pixels.fill(4, 600, 900)
    expect(decodeRle(encodeRle(pixels, width, height), width, height)).toEqual(pixels)
  })

  it('stops at the picture edge on runs that overflow it', () => {
    // A run of 10 on a 4-pixel line, then the end of the line.
    const data = Uint8Array.from([0, 0x80 | 10, 5, 0, 0, 7, 0, 0])
    expect(Array.from(decodeRle(data, 4, 2))).toEqual([5, 5, 5, 5, 7, 0, 0, 0])
  })
})

describe('PgsDecoder', () => {
  const show = writeDisplaySet({
    time: 1,
    width: 1920,
    height: 1080,
    compositionNumber: 0,
    palette,
    objects: [
      { x: 660, y: 950, width: 600, height: 60, pixels: boxPixels(600, 60, 1, 2) },
      { x: 700, y: 880, width: 520, height: 50, pixels: boxPixels(520, 50, 3, 2) },
    ],
  })
  const clear = writeDisplaySet({
    time: 4,
    width: 1920,
    height: 1080,
    compositionNumber: 1,
    objects: [],
  })

  it('shows the objects of a display set where it places them, in its colours', () => {
    const decoder = new PgsDecoder()
    const [event] = decoder.decode(show, 1)
    expect(event).toMatchObject({ start: 1, end: null, canvasWidth: 1920, canvasHeight: 1080 })
    expect(event!.pictures.map((p) => [p.x, p.y, p.width, p.height])).toEqual([
      [660, 950, 600, 60],
      [700, 880, 520, 50],
    ])
    const [first, second] = event!.pictures
    expect(near(pixel(first!.rgba, 600, 300, 30), [255, 220, 0, 255])).toBe(true)
    expect(near(pixel(first!.rgba, 600, 0, 0), [0, 0, 0, 255])).toBe(true)
    // Half-transparent white keeps its alpha as the file has it.
    expect(near(pixel(second!.rgba, 520, 200, 25), [255, 255, 255, 128])).toBe(true)
  })

  it('clears the screen with an empty composition', () => {
    const decoder = new PgsDecoder()
    decoder.decode(show, 1)
    const [event] = decoder.decode(clear, 4)
    expect(event).toMatchObject({ start: 4, pictures: [] })
  })

  it('shows an object again from an earlier display set of the same epoch', () => {
    const decoder = new PgsDecoder()
    decoder.decode(show, 1)
    // A normal composition: object 0 again, at a new place, nothing re-sent.
    // prettier-ignore
    const pcs = [
      0x16, 0, 19, // PCS, 19 bytes
      0x07, 0x80, 0x04, 0x38, 0x10, 0, 2, // 1920 × 1080, composition 2
      0x00, 0x00, 0x00, 1, // a normal composition, palette 0, one object:
      0, 0, 0, 0x00, 0, 0x10, 0, 0x20, // object 0 at (16, 32)
    ]
    const [event] = decoder.decode(Uint8Array.from([...pcs, 0x80, 0, 0]), 2)
    expect(event!.pictures.map((p) => [p.x, p.y, p.width])).toEqual([[16, 32, 600]])
  })

  it('joins an object sent in several pieces', () => {
    const whole = writeDisplaySet({
      time: 0,
      width: 1920,
      height: 1080,
      compositionNumber: 0,
      palette,
      objects: [{ x: 10, y: 20, width: 40, height: 12, pixels: boxPixels(40, 12, 1, 2) }],
    })
    // Find the ODS and split its data over two segments: first (0x80), then last (0x40).
    let at = 0
    const parts: number[][] = []
    while (at < whole.length) {
      const size = (whole[at + 1]! << 8) | whole[at + 2]!
      parts.push(Array.from(whole.subarray(at, at + 3 + size)))
      at += 3 + size
    }
    const ods = parts.findIndex((p) => p[0] === 0x15)
    const body = parts[ods]!.slice(3)
    const head = body.slice(0, 11 + 10)
    const tail = body.slice(11 + 10)
    const first = [...head.slice(0, 3), 0x80, ...head.slice(4)]
    const last = [body[0]!, body[1]!, body[2]!, 0x40, ...tail]
    const segmentOf = (data: number[]) => [0x15, data.length >> 8, data.length & 255, ...data]
    const split = [
      ...parts.slice(0, ods).flat(),
      ...segmentOf(first),
      ...segmentOf(last),
      ...parts.slice(ods + 1).flat(),
    ]
    const [event] = new PgsDecoder().decode(Uint8Array.from(split), 0)
    const picture = event!.pictures[0]!
    expect([picture.width, picture.height]).toEqual([40, 12])
    expect(near(pixel(picture.rgba, 40, 20, 6), [255, 220, 0, 255])).toBe(true)
    expect(near(pixel(picture.rgba, 40, 39, 11), [0, 0, 0, 255])).toBe(true)
  })

  it('reads .sup files, whose segments each carry a "PG" header', () => {
    const sup = writeSup([
      {
        time: 2,
        width: 720,
        height: 480,
        compositionNumber: 0,
        palette,
        objects: [{ x: 1, y: 2, width: 8, height: 4, pixels: boxPixels(8, 4, 1, 2, 1) }],
      },
    ])
    const [event] = new PgsDecoder().decode(sup, 2)
    expect(event!.pictures).toHaveLength(1)
  })

  it('shows nothing from damaged data rather than failing', () => {
    const decoder = new PgsDecoder()
    expect(() =>
      decoder.decode(Uint8Array.from([0x16, 0, 3, 1, 2, 3, 0x15, 0xff]), 0),
    ).not.toThrow()
    expect(() => decoder.decode(show.subarray(0, show.length - 40), 0)).not.toThrow()
  })
})
