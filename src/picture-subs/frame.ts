// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * Picture subtitles: the subtitles Blu-ray (PGS), DVD (VobSub), digital TV (DVB) and DivX (XSUB)
 * releases carry as little images rather than text. Each format is decoded to the same thing
 * here: what is on screen from a moment on, as pictures placed on the subtitle's own canvas (the
 * size of the video it was made for), which the player scales onto the picture as VLC does.
 */

/** One picture on the subtitle canvas, in straight (not premultiplied) RGBA. */
export interface SubPicture {
  x: number
  y: number
  width: number
  height: number
  /** width × height × 4 bytes. */
  rgba: Uint8ClampedArray
}

/** What a picture subtitle track shows, from [start] on. */
export interface PictureEvent {
  /** Seconds, media time. */
  start: number
  /**
   * Seconds, when the stream says when it goes; otherwise it stays until the next event (PGS
   * and DVB clear the screen with an event of their own).
   */
  end: number | null
  /** The pictures, none for an event that clears the screen. */
  pictures: SubPicture[]
  /** The canvas the positions are on; 0 when the stream does not say (the video's size). */
  canvasWidth: number
  canvasHeight: number
}

/** What is on screen at one moment: the pictures and the canvas they are placed on. */
export interface PictureFrame {
  pictures: SubPicture[]
  canvasWidth: number
  canvasHeight: number
}

/** A decoder for one picture subtitle format: packets in, screen changes out. */
export interface PictureDecoder {
  /** One demuxed packet at [pts] seconds, lasting [duration] seconds (0 when unknown). */
  decode(data: Uint8Array, pts: number, duration: number): PictureEvent[]
  /** Forgets what earlier packets set up (after a seek, packets arrive from a new place). */
  reset(): void
}

/** Limited-range Y′CbCr to RGB, with BT.709 coefficients for HD, BT.601 otherwise. */
export function yCbCrToRgb(
  y: number,
  cb: number,
  cr: number,
  hd: boolean,
): [number, number, number] {
  const l = 1.164 * (y - 16)
  const u = cb - 128
  const v = cr - 128
  const [rv, gu, gv, bu] = hd ? [1.793, 0.213, 0.533, 2.112] : [1.596, 0.392, 0.813, 2.017]
  return [clamp(l + rv * v), clamp(l - gu * u - gv * v), clamp(l + bu * u)]
}

export function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

/** The part of a picture that is not fully transparent, or null when nothing shows. */
export function trimPicture(picture: SubPicture): SubPicture | null {
  const { width, height, rgba } = picture
  let top = height
  let bottom = -1
  let left = width
  let right = -1
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (rgba[(row * width + col) * 4 + 3] === 0) continue
      if (row < top) top = row
      if (row > bottom) bottom = row
      if (col < left) left = col
      if (col > right) right = col
    }
  }
  if (bottom < 0) return null
  if (top === 0 && left === 0 && bottom === height - 1 && right === width - 1) return picture
  const w = right - left + 1
  const h = bottom - top + 1
  const out = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const from = ((top + row) * width + left) * 4
    out.set(rgba.subarray(from, from + w * 4), row * w * 4)
  }
  return { x: picture.x + left, y: picture.y + top, width: w, height: h, rgba: out }
}
