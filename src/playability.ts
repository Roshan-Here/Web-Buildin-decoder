// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * Whether the browser's own `<video>` can play a file, so an app can choose between it and the
 * built-in decoder. It is judged before anything downloads, from the
 * file's MIME type and the hints in its name. The element's own error event remains the final word.
 */
export type Playability = 'yes' | 'maybe' | 'no'

export interface PlayabilityInput {
  mimeType: string
  fileName: string | null
  /** The video codec when your backend knows it ("avc1", "hevc", "av01"). */
  codec?: string | null
}

export type CanPlay = (type: string) => '' | 'maybe' | 'probably'

const EXTENSION_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
}

/** The type to serve a file as, preferring the name's extension when the backend says octet-stream. */
export function effectiveMimeType({ mimeType, fileName }: PlayabilityInput): string {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('video/')) return mime
  const ext = fileName?.split('.').pop()?.toLowerCase()
  return (ext && EXTENSION_TYPES[ext]) || mime || 'application/octet-stream'
}

export function playability(input: PlayabilityInput, canPlay: CanPlay): Playability {
  const mime = effectiveMimeType(input)
  if (!mime.startsWith('video/')) return 'no'

  const hevc =
    /\b(hevc|h\.?265|x265)\b/i.test(input.fileName ?? '') ||
    /^(hev|hvc|hevc)/i.test(input.codec ?? '')
  const av1 = /\bav1\b/i.test(input.fileName ?? '') || /^av01/i.test(input.codec ?? '')

  const container = mime === 'video/quicktime' ? 'video/mp4' : mime
  const probe = hevc
    ? `${container}; codecs="hvc1.1.6.L93.B0"`
    : av1
      ? `${container}; codecs="av01.0.05M.08"`
      : container
  const answer = canPlay(probe)
  if (answer === 'probably') return 'yes'
  if (answer === 'maybe') {
    // Browsers say "maybe" to Matroska and play almost none of it natively.
    return mime === 'video/x-matroska' ? 'no' : 'yes'
  }
  return mime === 'video/x-matroska' && !hevc ? 'maybe' : 'no'
}

let probeElement: HTMLVideoElement | null = null

/** `canPlayType` of this browser. */
export const browserCanPlay: CanPlay = (type) => {
  probeElement ??= document.createElement('video')
  return probeElement.canPlayType(type)
}
