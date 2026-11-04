/*
 * Writes PGS (`.sup`) display sets, for the tests and the test videos (`npm run e2e:fixtures`)
 * only: the app reads PGS, it never writes it. Kept to what a Blu-ray authoring tool emits for
 * plain subtitles: an epoch start with its palette, windows and objects, or an empty
 * composition that clears the screen.
 */

export interface PgsColour {
  /** 0 to 255 each, straight alpha. */
  r: number
  g: number
  b: number
  a: number
}

export interface PgsObjectSpec {
  x: number
  y: number
  width: number
  height: number
  /** The palette index of each pixel, row by row. */
  pixels: Uint8Array
}

export interface PgsDisplaySetSpec {
  /** Seconds. */
  time: number
  width: number
  height: number
  compositionNumber: number
  /** Palette index to colour; index 0 is usually transparent. */
  palette?: Map<number, PgsColour>
  /** None clears the screen. */
  objects: PgsObjectSpec[]
}

/** BT.709 limited range, as Blu-ray HD subtitles are. */
function rgbToYCbCr({ r, g, b }: PgsColour): [number, number, number] {
  const y = 16 + 0.1826 * r + 0.6142 * g + 0.062 * b
  const cb = 128 - 0.1006 * r - 0.3386 * g + 0.4392 * b
  const cr = 128 + 0.4392 * r - 0.3989 * g - 0.0403 * b
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return [c(y), c(cb), c(cr)]
}

/** PGS run-length coding of one object. */
export function encodeRle(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out: number[] = []
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const colour = pixels[y * width + x]!
      let run = 1
      while (x + run < width && pixels[y * width + x + run] === colour && run < 16383) run++
      if (colour !== 0 && run <= 2) {
        for (let i = 0; i < run; i++) out.push(colour)
      } else if (colour === 0) {
        if (run < 64) out.push(0, run)
        else out.push(0, 0x40 | (run >> 8), run & 0xff)
      } else if (run < 64) out.push(0, 0x80 | run, colour)
      else out.push(0, 0xc0 | (run >> 8), run & 0xff, colour)
      x += run
    }
    out.push(0, 0)
  }
  return Uint8Array.from(out)
}

function segment(type: number, body: number[]): number[] {
  return [type, (body.length >> 8) & 0xff, body.length & 0xff, ...body]
}

const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff]

/** One display set's segments (PCS, WDS, PDS, ODS…, END), without `.sup` headers. */
export function writeDisplaySet(spec: PgsDisplaySetSpec): Uint8Array {
  const out: number[] = []
  const epochStart = spec.objects.length > 0
  const pcs = [
    ...u16(spec.width),
    ...u16(spec.height),
    0x10, // 23.976 fps
    ...u16(spec.compositionNumber),
    epochStart ? 0x80 : 0x00,
    0x00, // no palette-only update
    0x00, // palette 0
    spec.objects.length,
  ]
  spec.objects.forEach((object, i) => {
    pcs.push(...u16(i), i, 0x00, ...u16(object.x), ...u16(object.y))
  })
  out.push(...segment(0x16, pcs))
  const wds = [spec.objects.length]
  spec.objects.forEach((object, i) => {
    wds.push(i, ...u16(object.x), ...u16(object.y), ...u16(object.width), ...u16(object.height))
  })
  out.push(...segment(0x17, wds))
  if (epochStart && spec.palette) {
    const pds = [0x00, 0x00]
    for (const [index, colour] of spec.palette) {
      const [y, cb, cr] = rgbToYCbCr(colour)
      pds.push(index, y, cr, cb, colour.a)
    }
    out.push(...segment(0x14, pds))
  }
  spec.objects.forEach((object, i) => {
    const rle = encodeRle(object.pixels, object.width, object.height)
    const length = rle.length + 4
    // Small objects fit one segment; the tests split larger ones by hand.
    out.push(
      ...segment(0x15, [
        ...u16(i),
        0x00,
        0xc0, // first and last fragment
        (length >> 16) & 0xff,
        (length >> 8) & 0xff,
        length & 0xff,
        ...u16(object.width),
        ...u16(object.height),
        ...rle,
      ]),
    )
  })
  out.push(...segment(0x80, []))
  return Uint8Array.from(out)
}

/** A `.sup` file: each display set's segments with the "PG" header and its time. */
export function writeSup(sets: readonly PgsDisplaySetSpec[]): Uint8Array {
  const parts: number[] = []
  for (const set of sets) {
    const pts = Math.round(set.time * 90_000)
    const body = writeDisplaySet(set)
    // Every segment gets its own header.
    let at = 0
    while (at < body.length) {
      const size = (body[at + 1]! << 8) | body[at + 2]!
      parts.push(
        0x50,
        0x47,
        (pts >>> 24) & 0xff,
        (pts >>> 16) & 0xff,
        (pts >>> 8) & 0xff,
        pts & 0xff,
        0,
        0,
        0,
        0,
        ...body.subarray(at, at + 3 + size),
      )
      at += 3 + size
    }
  }
  return Uint8Array.from(parts)
}

/** A filled box of [fill] with a [border]-pixel frame of [edge], as palette indices. */
export function boxPixels(
  width: number,
  height: number,
  fill: number,
  edge: number,
  border = 3,
): Uint8Array {
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onEdge = x < border || y < border || x >= width - border || y >= height - border
      pixels[y * width + x] = onEdge ? edge : fill
    }
  }
  return pixels
}
