// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import { yCbCrToRgb, type PictureDecoder, type PictureEvent, type SubPicture } from './frame.js'

/*
 * DVB subtitles (codec `dvb_subtitle`, ETSI EN 300 743), as digital TV recordings carry them:
 * a page of regions, each a small picture of pixel codes coloured through a colour look-up
 * table (CLUT), filled in by objects drawn into it. A display set says which regions show
 * where, and stays until the next one or the page's time-out. Written after the standard as
 * libavcodec's dvbsubdec reads it.
 */

const PAGE = 0x10
const REGION = 0x11
const CLUT = 0x12
const OBJECT = 0x13
const DISPLAY = 0x14
const END = 0x80

interface Region {
  width: number
  height: number
  /** 2, 4 or 8 bits a pixel. */
  depth: 2 | 4 | 8
  clutId: number
  /** Pixel codes, one a byte. */
  pixels: Uint8Array
  /** The objects drawn into it, and where. */
  objects: Array<{ id: number; x: number; y: number }>
  background: number
}

interface PageRegion {
  id: number
  x: number
  y: number
}

/** A CLUT: an RGBA table for each depth. */
interface Clut {
  2: Uint8ClampedArray
  4: Uint8ClampedArray
  8: Uint8ClampedArray
}

export class DvbDecoder implements PictureDecoder {
  private regions = new Map<number, Region>()
  private cluts = new Map<number, Clut>()
  private page: { timeout: number; regions: PageRegion[] } | null = null
  private display = { width: 720, height: 576 }
  private changed = false

  reset(): void {
    this.regions.clear()
    this.cluts.clear()
    this.page = null
    this.display = { width: 720, height: 576 }
    this.changed = false
  }

  decode(data: Uint8Array, pts: number): PictureEvent[] {
    let at = 0
    // PES data starts with data_identifier 0x20 and stream id 0x00; demuxers may keep them.
    if (data[0] === 0x20 && data[1] === 0x00) at = 2
    const events: PictureEvent[] = []
    let ended = false
    while (at + 6 <= data.length && data[at] === 0x0f) {
      const type = data[at + 1]!
      const length = u16(data, at + 4)
      const body = data.subarray(at + 6, Math.min(data.length, at + 6 + length))
      at += 6 + length
      try {
        switch (type) {
          case PAGE:
            this.readPage(body)
            break
          case REGION:
            this.readRegion(body)
            break
          case CLUT:
            this.readClut(body)
            break
          case OBJECT:
            this.readObject(body)
            break
          case DISPLAY:
            this.readDisplay(body)
            break
          case END: {
            ended = true
            const event = this.compose(pts)
            if (event) events.push(event)
            break
          }
        }
      } catch {
        // A damaged segment: carry on with the rest.
      }
    }
    // Some streams never send an end segment: show what the packet set up anyway.
    if (!ended && this.changed) {
      const event = this.compose(pts)
      if (event) events.push(event)
    }
    return events
  }

  private readPage(body: Uint8Array): void {
    if (body.length < 2) return
    const timeout = body[0]!
    const state = (body[1]! >> 2) & 3
    // A mode change (an epoch start) forgets everything; an acquisition point refreshes all.
    if (state === 2) {
      this.regions.clear()
      this.cluts.clear()
    }
    const regions: PageRegion[] = []
    for (let at = 2; at + 6 <= body.length; at += 6) {
      regions.push({ id: body[at]!, x: u16(body, at + 2), y: u16(body, at + 4) })
    }
    this.page = { timeout, regions }
    this.changed = true
  }

  private readRegion(body: Uint8Array): void {
    if (body.length < 10) return
    const id = body[0]!
    const fill = (body[1]! & 0x08) !== 0
    const width = u16(body, 2)
    const height = u16(body, 4)
    const depthCode = (body[6]! >> 2) & 7
    const depth: 2 | 4 | 8 = depthCode === 1 ? 2 : depthCode === 2 ? 4 : 8
    const clutId = body[7]!
    const background = depth === 8 ? body[8]! : depth === 4 ? body[9]! >> 4 : (body[9]! >> 2) & 3
    let region = this.regions.get(id)
    if (!region || region.width !== width || region.height !== height || region.depth !== depth) {
      if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return
      region = {
        width,
        height,
        depth,
        clutId,
        pixels: new Uint8Array(width * height).fill(background),
        objects: [],
        background,
      }
      this.regions.set(id, region)
    } else {
      region.clutId = clutId
      region.background = background
      if (fill) region.pixels.fill(background)
    }
    region.objects = []
    for (let at = 10; at + 6 <= body.length;) {
      const objectId = u16(body, at)
      const type = body[at + 2]! >> 6
      const x = ((body[at + 2]! & 0x0f) << 8) | body[at + 3]!
      const y = ((body[at + 4]! & 0x0f) << 8) | body[at + 5]!
      region.objects.push({ id: objectId, x, y })
      at += type === 1 || type === 2 ? 8 : 6
    }
    this.changed = true
  }

  private readClut(body: Uint8Array): void {
    if (body.length < 2) return
    const id = body[0]!
    const clut = this.cluts.get(id) ?? defaultClut()
    let at = 2
    while (at + 2 <= body.length) {
      const entry = body[at]!
      const flags = body[at + 1]!
      let y: number
      let cr: number
      let cb: number
      let t: number
      if (flags & 1) {
        if (at + 6 > body.length) break
        y = body[at + 2]!
        cr = body[at + 3]!
        cb = body[at + 4]!
        t = body[at + 5]!
        at += 6
      } else {
        if (at + 4 > body.length) break
        const word = u16(body, at + 2)
        y = (word >> 10) << 2
        cr = ((word >> 6) & 15) << 4
        cb = ((word >> 2) & 15) << 4
        t = (word & 3) << 6
        at += 4
      }
      const [r, g, b] = yCbCrToRgb(y, cb, cr, false)
      // Luma 0 is "fully transparent" in DVB.
      const alpha = y === 0 ? 0 : 255 - t
      if (flags & 0x80 && entry < 4) clut[2].set([r, g, b, alpha], entry * 4)
      if (flags & 0x40 && entry < 16) clut[4].set([r, g, b, alpha], entry * 4)
      if (flags & 0x20) clut[8].set([r, g, b, alpha], entry * 4)
    }
    this.cluts.set(id, clut)
    this.changed = true
  }

  private readObject(body: Uint8Array): void {
    if (body.length < 3) return
    const id = u16(body, 0)
    const coding = (body[2]! >> 2) & 3
    const nonModifying = (body[2]! & 2) !== 0
    // Character-coded objects are not used by any broadcaster in practice.
    if (coding !== 0 || body.length < 7) return
    const topLength = u16(body, 3)
    const bottomLength = u16(body, 5)
    const top = body.subarray(7, 7 + topLength)
    const bottom =
      bottomLength > 0 ? body.subarray(7 + topLength, 7 + topLength + bottomLength) : top
    for (const region of this.regions.values()) {
      for (const placed of region.objects) {
        if (placed.id !== id) continue
        drawField(region, top, placed.x, placed.y, nonModifying)
        drawField(region, bottom, placed.x, placed.y + 1, nonModifying)
      }
    }
    this.changed = true
  }

  private readDisplay(body: Uint8Array): void {
    if (body.length < 5) return
    this.display = { width: u16(body, 1) + 1, height: u16(body, 3) + 1 }
  }

  private compose(pts: number): PictureEvent | null {
    this.changed = false
    const page = this.page
    if (!page) return null
    const pictures: SubPicture[] = []
    for (const placed of page.regions) {
      const region = this.regions.get(placed.id)
      if (!region) continue
      const table = (this.cluts.get(region.clutId) ?? defaultClut())[region.depth]
      const rgba = new Uint8ClampedArray(region.width * region.height * 4)
      let visible = false
      for (let i = 0; i < region.pixels.length; i++) {
        const entry = region.pixels[i]! * 4
        const alpha = table[entry + 3]!
        if (alpha === 0) continue
        visible = true
        rgba[i * 4] = table[entry]!
        rgba[i * 4 + 1] = table[entry + 1]!
        rgba[i * 4 + 2] = table[entry + 2]!
        rgba[i * 4 + 3] = alpha
      }
      if (visible)
        pictures.push({
          x: placed.x,
          y: placed.y,
          width: region.width,
          height: region.height,
          rgba,
        })
    }
    return {
      start: pts,
      end: page.timeout > 0 ? pts + page.timeout : null,
      pictures,
      canvasWidth: this.display.width,
      canvasHeight: this.display.height,
    }
  }
}

/** A reader of bits, most significant first. */
class Bits {
  private bit = 0
  constructor(
    private readonly data: Uint8Array,
    private at = 0,
  ) {}

  read(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.at] ?? 0
      value = (value << 1) | ((byte >> (7 - this.bit)) & 1)
      if (++this.bit === 8) {
        this.bit = 0
        this.at++
      }
    }
    return value
  }

  align(): void {
    if (this.bit) {
      this.bit = 0
      this.at++
    }
  }

  get offset(): number {
    return this.at
  }

  get done(): boolean {
    return this.at >= this.data.length
  }
}

/** Draws one field of an object (every other line) into a region from (x, y) down. */
function drawField(
  region: Region,
  data: Uint8Array,
  x0: number,
  y0: number,
  nonModifying: boolean,
): void {
  // The default map tables, which a field can replace for itself.
  let map2to4 = [0x0, 0x7, 0x8, 0xf]
  let map2to8 = [0x00, 0x77, 0x88, 0xff]
  let map4to8 = Array.from({ length: 16 }, (_, i) => i * 0x11)
  let x = x0
  let y = y0
  let at = 0
  /** [run] pixels of [code] (already mapped to the region's depth); [raw] as the data had it. */
  const put = (code: number, raw: number, run: number) => {
    // With the non-modifying colour flag, code 1 leaves what is under it alone.
    if (y < 0 || y >= region.height || (nonModifying && raw === 1)) {
      x += run
      return
    }
    for (let i = 0; i < run; i++, x++) {
      if (x >= 0 && x < region.width) region.pixels[y * region.width + x] = code
    }
  }
  while (at < data.length) {
    const type = data[at++]!
    switch (type) {
      case 0x10:
      case 0x11:
      case 0x12: {
        const bits = new Bits(data, at)
        const depth = type === 0x10 ? 2 : type === 0x11 ? 4 : 8
        const translate = (code: number) =>
          depth === region.depth
            ? code
            : depth === 2
              ? region.depth === 4
                ? map2to4[code]!
                : map2to8[code]!
              : depth === 4 && region.depth === 8
                ? map4to8[code]!
                : // A deeper code into a shallower region: keep its low bits, as decoders do.
                  code & ((1 << region.depth) - 1)
        const emit: Emit = (code, run) => put(translate(code), code, run)
        const room = Math.max(0, region.width - x)
        if (depth === 2) readString2(bits, room, emit)
        else if (depth === 4) readString4(bits, room, emit)
        else readString8(bits, room, emit)
        at = bits.offset
        break
      }
      case 0x20:
        map2to4 = [data[at]! >> 4, data[at]! & 15, data[at + 1]! >> 4, data[at + 1]! & 15]
        at += 2
        break
      case 0x21:
        map2to8 = [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!]
        at += 4
        break
      case 0x22:
        map4to8 = Array.from(data.subarray(at, at + 16))
        at += 16
        break
      case 0xf0: // end of a line
        x = x0
        y += 2
        break
      default:
        // Not a block type: a stray byte (a full end code after a full line), skipped.
        break
    }
  }
}

type Emit = (code: number, run: number) => void

/*
 * The pixel code strings. Each ends with its end code, or as soon as it has filled the rest of
 * the region's line ([room] pixels), after which only the first bits of an end code follow (6
 * for 2-bit codes, a byte for 4- and 8-bit ones): encoders, FFmpeg's among them, write a full
 * line that way.
 */

function readString2(bits: Bits, room: number, emit: Emit): void {
  let read = 0
  const fill = (code: number, run: number) => {
    emit(code, run)
    read += run
  }
  for (;;) {
    if (bits.done) return
    if (read >= room) {
      bits.read(6)
      break
    }
    const code = bits.read(2)
    if (code) {
      fill(code, 1)
      continue
    }
    if (bits.read(1)) {
      const run = bits.read(3) + 3
      fill(bits.read(2), run)
      continue
    }
    if (bits.read(1)) {
      fill(0, 1)
      continue
    }
    const kind = bits.read(2)
    if (kind === 2) {
      const run = bits.read(4) + 12
      fill(bits.read(2), run)
    } else if (kind === 3) {
      const run = bits.read(8) + 29
      fill(bits.read(2), run)
    } else if (kind === 1) fill(0, 2)
    else break
  }
  bits.align()
}

function readString4(bits: Bits, room: number, emit: Emit): void {
  let read = 0
  const fill = (code: number, run: number) => {
    emit(code, run)
    read += run
  }
  for (;;) {
    if (bits.done) return
    if (read >= room) {
      bits.read(8)
      break
    }
    const code = bits.read(4)
    if (code) {
      fill(code, 1)
      continue
    }
    if (bits.read(1) === 0) {
      const run = bits.read(3)
      if (run === 0) break
      fill(0, run + 2)
      continue
    }
    if (bits.read(1) === 0) {
      const run = bits.read(2) + 4
      fill(bits.read(4), run)
      continue
    }
    const kind = bits.read(2)
    if (kind === 2) {
      const run = bits.read(4) + 9
      fill(bits.read(4), run)
    } else if (kind === 3) {
      const run = bits.read(8) + 25
      fill(bits.read(4), run)
    } else if (kind === 1) fill(0, 2)
    else fill(0, 1)
  }
  bits.align()
}

function readString8(bits: Bits, room: number, emit: Emit): void {
  let read = 0
  for (;;) {
    if (bits.done) return
    if (read >= room) {
      bits.read(8)
      break
    }
    const code = bits.read(8)
    if (code) {
      emit(code, 1)
      read++
      continue
    }
    const long = bits.read(1)
    const run = bits.read(7)
    if (!long) {
      if (run === 0) break
      emit(0, run)
    } else emit(bits.read(8), run)
    read += run
  }
  bits.align()
}

/** The CLUTs a stream starts with before it defines its own (EN 300 743, 10.1 to 10.3). */
function defaultClut(): Clut {
  const two = new Uint8ClampedArray(4 * 4)
  two.set([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 127, 127, 127, 255])
  const four = new Uint8ClampedArray(16 * 4)
  for (let i = 1; i < 16; i++) {
    const level = i < 8 ? 255 : 127
    four.set([i & 1 ? level : 0, i & 2 ? level : 0, i & 4 ? level : 0, 255], i * 4)
  }
  const eight = new Uint8ClampedArray(256 * 4)
  for (let i = 1; i < 256; i++) {
    let r: number
    let g: number
    let b: number
    let a = 255
    if (i < 8) {
      r = i & 1 ? 255 : 0
      g = i & 2 ? 255 : 0
      b = i & 4 ? 255 : 0
      a = 63
    } else {
      const low = (bit: number, value: number) => (i & bit ? value : 0)
      switch (i & 0x88) {
        case 0x00:
        case 0x08:
          r = low(1, 85) + low(0x10, 170)
          g = low(2, 85) + low(0x20, 170)
          b = low(4, 85) + low(0x40, 170)
          a = (i & 0x88) === 0x08 ? 127 : 255
          break
        case 0x80:
          r = 127 + low(1, 43) + low(0x10, 85)
          g = 127 + low(2, 43) + low(0x20, 85)
          b = 127 + low(4, 43) + low(0x40, 85)
          break
        default:
          r = low(1, 43) + low(0x10, 85)
          g = low(2, 43) + low(0x20, 85)
          b = low(4, 43) + low(0x40, 85)
      }
    }
    eight.set([r, g, b, a], i * 4)
  }
  return { 2: two, 4: four, 8: eight }
}

function u16(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)
}
