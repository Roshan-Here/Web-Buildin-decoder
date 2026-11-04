// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import { yCbCrToRgb, type PictureDecoder, type PictureEvent, type SubPicture } from './frame.js'

/*
 * PGS, the Blu-ray subtitle format (codec `hdmv_pgs_subtitle`, `.sup` files): each packet is a
 * display set of segments that together say what is on screen from its time on.
 *
 * - PCS (presentation composition): the canvas size, which objects show where (cropped or not),
 *   and whether this starts a new epoch (everything before is forgotten);
 * - WDS (windows): where on the canvas drawing may happen; nothing to draw from it here;
 * - PDS (palettes): up to 256 Y′CbCr+alpha entries, by palette id;
 * - ODS (objects): run-length coded pictures, split over several segments when large;
 * - END: the display set is complete.
 *
 * Palettes and objects live for the whole epoch, so a later display set can show an object
 * sent earlier, or only change its palette (a fade). A composition with no objects clears the
 * screen. Written after the format as libavcodec's pgssubdec reads it.
 */

const PDS = 0x14
const ODS = 0x15
const PCS = 0x16
const WDS = 0x17
const END = 0x80

const EPOCH_START = 0x80

interface Placement {
  objectId: number
  x: number
  y: number
  crop: { x: number; y: number; width: number; height: number } | null
}

interface Composition {
  width: number
  height: number
  paletteId: number
  placements: Placement[]
}

interface PgsObject {
  width: number
  height: number
  /** The run-length data gathered so far, and how long it will be when whole. */
  data: Uint8Array
  filled: number
  /** Decoded palette indices, once the data is whole. */
  indices: Uint8Array | null
}

/** A palette: 256 RGBA entries, 4 bytes each. */
type Palette = Uint8ClampedArray

export class PgsDecoder implements PictureDecoder {
  private palettes = new Map<number, Palette>()
  private objects = new Map<number, PgsObject>()
  private composition: Composition | null = null

  reset(): void {
    this.palettes.clear()
    this.objects.clear()
    this.composition = null
  }

  decode(data: Uint8Array, pts: number): PictureEvent[] {
    const events: PictureEvent[] = []
    for (const segment of segments(data)) {
      try {
        switch (segment.type) {
          case PCS:
            this.readComposition(segment.body)
            break
          case PDS:
            this.readPalette(segment.body)
            break
          case ODS:
            this.readObject(segment.body)
            break
          case WDS:
            break
          case END: {
            const event = this.compose(pts)
            if (event) events.push(event)
            break
          }
        }
      } catch {
        // A damaged segment: the rest of the display set may still draw.
      }
    }
    return events
  }

  private readComposition(body: Uint8Array): void {
    if (body.length < 11) return
    const width = u16(body, 0)
    const height = u16(body, 2)
    const state = body[7]!
    const paletteId = body[9]!
    const count = body[10]!
    if (state & EPOCH_START) {
      this.objects.clear()
      this.palettes.clear()
    }
    const placements: Placement[] = []
    let at = 11
    for (let i = 0; i < count && at + 8 <= body.length; i++) {
      const objectId = u16(body, at)
      const flags = body[at + 3]!
      const x = u16(body, at + 4)
      const y = u16(body, at + 6)
      at += 8
      let crop: Placement['crop'] = null
      if (flags & 0x80) {
        if (at + 8 > body.length) break
        crop = {
          x: u16(body, at),
          y: u16(body, at + 2),
          width: u16(body, at + 4),
          height: u16(body, at + 6),
        }
        at += 8
      }
      placements.push({ objectId, x, y, crop })
    }
    this.composition = { width, height, paletteId, placements }
  }

  private readPalette(body: Uint8Array): void {
    if (body.length < 2) return
    const id = body[0]!
    const hd = (this.composition?.height ?? 1080) > 576
    const palette = this.palettes.get(id) ?? new Uint8ClampedArray(256 * 4)
    for (let at = 2; at + 5 <= body.length; at += 5) {
      const index = body[at]!
      const [r, g, b] = yCbCrToRgb(body[at + 1]!, body[at + 3]!, body[at + 2]!, hd)
      palette.set([r, g, b, body[at + 4]!], index * 4)
    }
    this.palettes.set(id, palette)
  }

  private readObject(body: Uint8Array): void {
    if (body.length < 4) return
    const id = u16(body, 0)
    const sequence = body[3]!
    let object = this.objects.get(id)
    let at = 4
    if (sequence & 0x80) {
      // The first fragment: the data's length (with the 4 bytes of size), then the size.
      if (body.length < 11) return
      const length = Math.max(0, ((body[4]! << 16) | (body[5]! << 8) | body[6]!) - 4)
      object = {
        width: u16(body, 7),
        height: u16(body, 9),
        data: new Uint8Array(length),
        filled: 0,
        indices: null,
      }
      this.objects.set(id, object)
      at = 11
    }
    if (!object) return
    const chunk = body.subarray(at, Math.min(body.length, at + object.data.length - object.filled))
    object.data.set(chunk, object.filled)
    object.filled += chunk.length
    object.indices = null
    if (sequence & 0x40 || object.filled >= object.data.length) {
      object.indices = decodeRle(
        object.data.subarray(0, object.filled),
        object.width,
        object.height,
      )
    }
  }

  private compose(pts: number): PictureEvent | null {
    const composition = this.composition
    if (!composition) return null
    const palette = this.palettes.get(composition.paletteId)
    const pictures: SubPicture[] = []
    for (const placement of composition.placements) {
      const object = this.objects.get(placement.objectId)
      if (!object?.indices || !palette) continue
      const picture = paint(object, placement, palette)
      if (picture) pictures.push(picture)
    }
    return {
      start: pts,
      end: null,
      pictures,
      canvasWidth: composition.width,
      canvasHeight: composition.height,
    }
  }
}

/** The segments of a display set; `.sup` files' "PG" headers (with their times) skipped. */
function* segments(data: Uint8Array): Generator<{ type: number; body: Uint8Array }> {
  let at = 0
  while (at < data.length) {
    if (data[at] === 0x50 && data[at + 1] === 0x47) at += 10
    if (at + 3 > data.length) return
    const type = data[at]!
    const size = u16(data, at + 1)
    const body = data.subarray(at + 3, Math.min(data.length, at + 3 + size))
    yield { type, body }
    at += 3 + size
  }
}

/**
 * PGS run-length coding, one line after another: a non-zero byte is one pixel of that colour;
 * 0 then a code byte is a run (of colour 0, or of a colour that follows), or the end of a line.
 */
export function decodeRle(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  let x = 0
  let y = 0
  let at = 0
  const put = (colour: number, run: number) => {
    const count = Math.min(run, width - x)
    if (count > 0 && y < height) out.fill(colour, y * width + x, y * width + x + count)
    x += run
  }
  while (at < data.length && y < height) {
    const byte = data[at++]!
    if (byte !== 0) {
      put(byte, 1)
      continue
    }
    const code = data[at++] ?? 0
    if (code === 0) {
      x = 0
      y++
      continue
    }
    const long = (code & 0x40) !== 0
    const run = long ? ((code & 0x3f) << 8) | (data[at++] ?? 0) : code & 0x3f
    const colour = code & 0x80 ? (data[at++] ?? 0) : 0
    put(colour, run)
  }
  return out
}

/** An object's pictures through a palette, cropped as the composition says. */
function paint(object: PgsObject, placement: Placement, palette: Palette): SubPicture | null {
  const indices = object.indices!
  const crop = placement.crop ?? { x: 0, y: 0, width: object.width, height: object.height }
  const left = Math.min(crop.x, object.width)
  const top = Math.min(crop.y, object.height)
  const width = Math.min(crop.width, object.width - left)
  const height = Math.min(crop.height, object.height - top)
  if (width <= 0 || height <= 0) return null
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    const from = (top + row) * object.width + left
    for (let col = 0; col < width; col++) {
      const entry = indices[from + col]! * 4
      const to = (row * width + col) * 4
      rgba[to] = palette[entry]!
      rgba[to + 1] = palette[entry + 1]!
      rgba[to + 2] = palette[entry + 2]!
      rgba[to + 3] = palette[entry + 3]!
    }
  }
  return { x: placement.x, y: placement.y, width, height, rgba }
}

function u16(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)
}
