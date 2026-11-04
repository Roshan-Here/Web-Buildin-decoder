// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { PictureDecoder, PictureEvent, SubPicture } from './frame.js'

/*
 * VobSub, the DVD subtitle format (codec `dvd_subtitle`, `.idx`/`.sub` pairs and Matroska's
 * `S_VOBSUB`): each packet is one subpicture unit (SPU), a 4-colour picture with control
 * sequences that say when it shows and goes, which 4 of the disc's 16 colours it uses and how
 * opaque each is, and where it sits. The 16 colours come from the stream's header (the `.idx`
 * text: `palette: rrggbb, …`, and `size: 720x480`). Written after the DVD-Video SPU format as
 * libavcodec's dvdsubdec reads it.
 */

/** DVD control sequence dates count in units of 1024 ticks of the 90 kHz clock. */
const DATE_UNIT_S = 1024 / 90_000

/** Used when the header has no palette: dark to light greys, as players guess one. */
const GUESSED_PALETTE = Array.from({ length: 16 }, (_, i) => {
  const v = i === 0 ? 0 : Math.round((i / 15) * 255)
  return [v, v, v] as [number, number, number]
})

export interface VobSubHeader {
  palette: Array<[number, number, number]> | null
  width: number
  height: number
}

/** Reads the `.idx`-style header Matroska keeps as the track's codec private data. */
export function readVobSubHeader(extradata: Uint8Array | undefined): VobSubHeader {
  const header: VobSubHeader = { palette: null, width: 0, height: 0 }
  if (!extradata?.length) return header
  const text = new TextDecoder('latin1').decode(extradata)
  const size = /^\s*size:\s*(\d+)\s*x\s*(\d+)/im.exec(text)
  if (size) {
    header.width = Number(size[1])
    header.height = Number(size[2])
  }
  const palette = /^\s*palette:\s*(.+)$/im.exec(text)
  if (palette) {
    const colours = palette[1]!
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^[0-9a-f]{6}$/i.test(part))
      .map((hex) => {
        const value = parseInt(hex, 16)
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as [number, number, number]
      })
    if (colours.length >= 16) header.palette = colours.slice(0, 16)
  }
  return header
}

export class VobSubDecoder implements PictureDecoder {
  private readonly palette: Array<[number, number, number]>
  private readonly width: number
  private readonly height: number

  constructor(header: VobSubHeader = { palette: null, width: 0, height: 0 }) {
    this.palette = header.palette ?? GUESSED_PALETTE
    this.width = header.width
    this.height = header.height
  }

  reset(): void {
    // Every packet stands alone.
  }

  decode(data: Uint8Array, pts: number, duration: number): PictureEvent[] {
    try {
      return this.read(data, pts, duration)
    } catch {
      return []
    }
  }

  private read(data: Uint8Array, pts: number, duration: number): PictureEvent[] {
    if (data.length < 4) return []
    const size = Math.min(data.length, u16(data, 0) || data.length)
    const control = u16(data, 2)
    if (control >= size) return []

    let colours = [0, 1, 2, 3]
    let alphas = [0, 15, 15, 15]
    let area: { x1: number; x2: number; y1: number; y2: number } | null = null
    let fields: [number, number] | null = null
    let startAt: number | null = null
    let stopAt: number | null = null

    let at = control
    const seen = new Set<number>()
    while (at + 4 <= size && !seen.has(at)) {
      seen.add(at)
      const date = u16(data, at) * DATE_UNIT_S
      const next = u16(data, at + 2)
      let p = at + 4
      commands: while (p < size) {
        const command = data[p++]!
        switch (command) {
          case 0x00: // forced start
          case 0x01: // start display
            startAt ??= date
            break
          case 0x02: // stop display
            stopAt ??= date
            break
          case 0x03: // which palette entries the 4 colours use
            if (p + 2 > size) break commands
            colours = nibbles(data, p)
            p += 2
            break
          case 0x04: // their opacity, 0 to 15
            if (p + 2 > size) break commands
            alphas = nibbles(data, p)
            p += 2
            break
          case 0x05: // display area
            if (p + 6 > size) break commands
            area = {
              x1: (data[p]! << 4) | (data[p + 1]! >> 4),
              x2: ((data[p + 1]! & 0x0f) << 8) | data[p + 2]!,
              y1: (data[p + 3]! << 4) | (data[p + 4]! >> 4),
              y2: ((data[p + 4]! & 0x0f) << 8) | data[p + 5]!,
            }
            p += 6
            break
          case 0x06: // where each field's lines start
            if (p + 4 > size) break commands
            fields = [u16(data, p), u16(data, p + 2)]
            p += 4
            break
          case 0x07: {
            // Colour and contrast changes within the picture: skipped, as most players do.
            if (p + 2 > size) break commands
            p += u16(data, p)
            break
          }
          default: // 0xff ends the sequence; anything else cannot be read on from
            break commands
        }
      }
      if (next === at) break
      at = next
    }

    if (!area || !fields) return []
    const width = area.x2 - area.x1 + 1
    const height = area.y2 - area.y1 + 1
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return []
    const indices = decodeFields(data.subarray(0, size), fields, width, height)

    // The four colours, through the disc palette (the command lists them 3, 2, 1, 0).
    const lut = [0, 1, 2, 3].map((i) => {
      const [r, g, b] = this.palette[colours[3 - i]!] ?? [0, 0, 0]
      return [r, g, b, Math.round((alphas[3 - i]! / 15) * 255)]
    })
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < indices.length; i++) rgba.set(lut[indices[i]!]!, i * 4)
    const picture: SubPicture = { x: area.x1, y: area.y1, width, height, rgba }

    const start = pts + (startAt ?? 0)
    const end =
      stopAt != null && stopAt > (startAt ?? 0)
        ? pts + stopAt
        : duration > 0
          ? pts + duration
          : null
    return [
      {
        start,
        end,
        pictures: [picture],
        canvasWidth: this.width,
        canvasHeight: this.height,
      },
    ]
  }
}

/** Four 4-bit values from two bytes, high nibble first. */
function nibbles(data: Uint8Array, at: number): number[] {
  return [data[at]! >> 4, data[at]! & 15, data[at + 1]! >> 4, data[at + 1]! & 15]
}

/**
 * The picture's 2-bit colour indices: the two interlaced fields, each a run-length coded line
 * after another, each line ending on a byte boundary.
 */
export function decodeFields(
  data: Uint8Array,
  fields: [number, number],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let field = 0; field < 2; field++) {
    let nibble = fields[field]! * 2
    const read = () => {
      const byte = data[nibble >> 1] ?? 0
      const value = nibble & 1 ? byte & 15 : byte >> 4
      nibble++
      return value
    }
    for (let y = field; y < height; y += 2) {
      let x = 0
      while (x < width) {
        if (nibble >> 1 >= data.length) return out
        let v = read()
        if (v < 0x4) {
          v = (v << 4) | read()
          if (v < 0x10) {
            v = (v << 4) | read()
            if (v < 0x40) v = (v << 4) | read()
          }
        }
        const colour = v & 3
        let run = v >> 2
        if (run === 0 || x + run > width) run = width - x
        out.fill(colour, y * width + x, y * width + x + run)
        x += run
      }
      // Each line starts on a whole byte.
      if (nibble & 1) nibble++
    }
  }
  return out
}

function u16(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0)
}
