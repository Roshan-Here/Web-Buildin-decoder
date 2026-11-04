// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { PictureDecoder, PictureEvent } from './frame.js'

/*
 * XSUB, DivX's picture subtitles (codec `xsub`, in AVI files): each packet holds its own times
 * as text, "[00:01:02.345-00:01:05.678]", then the picture's size and place, 4 colours (the
 * first is the transparent background) and the picture, its even lines then its odd ones, run
 * length coded 2 bits a pixel. Written after the format as libavcodec's xsubdec reads it.
 */

const TIMES = /^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d)-(\d\d):(\d\d):(\d\d)\.(\d\d\d)\]$/

export class XSubDecoder implements PictureDecoder {
  reset(): void {
    // Every packet stands alone.
  }

  decode(data: Uint8Array): PictureEvent[] {
    try {
      return this.read(data)
    } catch {
      return []
    }
  }

  private read(data: Uint8Array): PictureEvent[] {
    if (data.length < 27 + 14 + 12) return []
    const times = TIMES.exec(new TextDecoder('latin1').decode(data.subarray(0, 27)))
    if (!times) return []
    const seconds = (from: number) =>
      Number(times[from]) * 3600 +
      Number(times[from + 1]) * 60 +
      Number(times[from + 2]) +
      Number(times[from + 3]) / 1000
    const start = seconds(1)
    const end = seconds(5)

    let at = 27
    const le16 = () => {
      const value = data[at]! | (data[at + 1]! << 8)
      at += 2
      return value
    }
    const width = le16()
    const height = le16()
    const x = le16()
    const y = le16()
    at += 4 // the bottom right corner, which says nothing new
    at += 2 // the second field's offset, which some files get wrong: not relied on
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return []
    if (at + 12 > data.length) return []
    const colours = [0, 1, 2, 3].map((i) => {
      const from = at + i * 3
      return [data[from]!, data[from + 1]!, data[from + 2]!, i === 0 ? 0 : 255]
    })
    at += 12

    // Even lines first, then odd ones, each starting on a whole byte.
    const indices = new Uint8Array(width * height)
    let bit = at * 8
    const read = (count: number) => {
      let value = 0
      for (let i = 0; i < count; i++, bit++) {
        const byte = data[bit >> 3] ?? 0
        value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1)
      }
      return value
    }
    const peek8 = () => {
      const saved = bit
      const value = read(8)
      bit = saved
      return value
    }
    const half = Math.ceil(height / 2)
    for (let line = 0; line < height; line++) {
      if (bit >> 3 >= data.length) break
      const row = line < half ? line * 2 : (line - half) * 2 + 1
      for (let col = 0; col < width;) {
        const log2 = Math.floor(Math.log2(peek8() || 1))
        let run = read(14 - 4 * (log2 >> 1))
        const colour = read(2)
        if (run === 0 || run > width - col) run = width - col
        if (row < height) indices.fill(colour, row * width + col, row * width + col + run)
        col += run
      }
      bit = Math.ceil(bit / 8) * 8
    }

    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < indices.length; i++) rgba.set(colours[indices[i]!]!, i * 4)
    return [
      {
        start,
        end: end > start ? end : null,
        pictures: [{ x, y, width, height, rgba }],
        canvasWidth: 0,
        canvasHeight: 0,
      },
    ]
  }
}
