// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { Packet, SubtitleRenderer, SubtitleTrack } from 'movi-player'
import {
  frameOf,
  isPictureSubtitle,
  pictureDecoderFor,
  PictureTimeline,
  type PictureFrame,
} from './picture-subs/index.js'
import type { PictureDecoder, PictureEvent } from './picture-subs/frame.js'

export { isPictureSubtitle } from './picture-subs/index.js'
export type { PictureFrame } from './picture-subs/index.js'

export interface Cue {
  start: number
  end: number
  text: string
}

/** Text subtitle codecs this renderer reads; picture ones (PGS, VobSub, DVB) are drawn apart. */
const TEXT_CODECS = new Set(['subrip', 'srt', 'text', 'ass', 'ssa', 'webvtt', 'mov_text'])

export function isTextSubtitle(codec: string): boolean {
  return TEXT_CODECS.has(codec.toLowerCase())
}

/** A cue without a duration shows until the next one, but never longer than this. */
const OPEN_ENDED_SECONDS = 6
/** Cues this far behind the playhead are forgotten; a seek back sends them again. */
const KEEP_BEHIND_SECONDS = 120

const decoder = new TextDecoder('utf-8')

/**
 * Turns one subtitle packet into plain text. Styling markup is removed rather than drawn:
 * SubRip tags, ASS override blocks like `{\an8}`, WebVTT voice and class tags.
 */
export function packetText(codec: string, data: Uint8Array): string {
  const kind = codec.toLowerCase()
  let raw: string
  if (kind === 'mov_text') {
    // 3GPP timed text: a 16-bit big-endian length, then UTF-8, then style boxes.
    const length = data.length >= 2 ? (data[0]! << 8) | data[1]! : 0
    raw = decoder.decode(data.subarray(2, 2 + length))
  } else {
    raw = decoder.decode(data)
  }

  if (kind === 'ass' || kind === 'ssa') {
    // Matroska stores an ASS event as ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text.
    const parts = raw.split(',')
    if (parts.length > 9 && /^\d+$/.test(parts[0]!.trim())) raw = parts.slice(8).join(',')
    else if (/^Dialogue:/i.test(raw))
      raw = raw
        .replace(/^Dialogue:\s*/i, '')
        .split(',')
        .slice(9)
        .join(',')
    raw = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
  }

  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/** Whether this player shows a subtitle codec: text, or pictures (PGS, VobSub, DVB). */
export function isShownSubtitle(codec: string): boolean {
  return isTextSubtitle(codec) || isPictureSubtitle(codec)
}

/**
 * movi-player's pluggable subtitle renderer, kept to what a custom player needs: it collects the
 * selected track's cues and reports what should be on screen, so your player draws subtitles
 * itself, above the picture and its own controls: the text of a text track, in its own style,
 * and the pictures of a picture track (PGS, VobSub, DVB, XSUB), decoded here (picture-subs/),
 * as the file has them.
 */
export class CaptionRenderer implements SubtitleRenderer {
  private codec = 'subrip'
  private cues: Cue[] = []
  private delay = 0
  private shown: string | null = null
  private readonly onChange: (text: string | null) => void
  private readonly onPicture: (frame: PictureFrame | null) => void
  private pictureDecoder: PictureDecoder | null = null
  private readonly pictures = new PictureTimeline()
  private shownPicture: { event: PictureEvent; width: number; height: number } | null = null

  constructor(
    onChange: (text: string | null) => void,
    onPicture: (frame: PictureFrame | null) => void = () => undefined,
  ) {
    this.onChange = onChange
    this.onPicture = onPicture
  }

  configure(track: SubtitleTrack, extradata?: Uint8Array): void {
    this.codec = track.codec
    this.pictureDecoder = pictureDecoderFor(track.codec, extradata)
    this.reset()
  }

  pushPacket(packet: Packet): void {
    if (this.pictureDecoder) {
      for (const event of this.pictureDecoder.decode(
        packet.data,
        packet.timestamp,
        packet.duration > 0 ? packet.duration : 0,
      ))
        this.pictures.add(event)
      return
    }
    if (!isTextSubtitle(this.codec)) return
    const text = packetText(this.codec, packet.data)
    if (!text) return
    const start = packet.timestamp
    const end = packet.duration > 0 ? start + packet.duration : Number.NaN
    // Packets can arrive again after a seek; keep one copy of each.
    if (this.cues.some((c) => c.start === start && c.text === text)) return
    this.cues.push({ start, end, text })
    this.cues.sort((a, b) => a.start - b.start)
  }

  render(mediaTime: number, videoWidth = 0, videoHeight = 0): void {
    const t = mediaTime - this.delay
    if (this.pictureDecoder) {
      this.pictures.forgetBefore(t)
      this.showPicture(this.pictures.at(t), videoWidth, videoHeight)
      return
    }
    this.cues = this.cues.filter((c) => endOf(c, this.cues) > t - KEEP_BEHIND_SECONDS)
    const active = this.cues.filter((c) => c.start <= t && t < endOf(c, this.cues))
    this.show(active.length > 0 ? active.map((c) => c.text).join('\n') : null)
  }

  setDelay(seconds: number): void {
    this.delay = seconds
  }

  clear(): void {
    this.reset()
  }

  destroy(): void {
    this.reset()
  }

  /** The cues (or picture screens) currently held, for tests. */
  get size(): number {
    return this.pictureDecoder ? this.pictures.size : this.cues.length
  }

  private reset(): void {
    this.cues = []
    this.pictures.clear()
    this.pictureDecoder?.reset()
    this.show(null)
    this.showPicture(null, 0, 0)
  }

  private showPicture(event: PictureEvent | null, width: number, height: number): void {
    const was = this.shownPicture
    if (
      event === (was?.event ?? null) &&
      (!event || (was?.width === width && was.height === height))
    )
      return
    this.shownPicture = event ? { event, width, height } : null
    this.onPicture(event ? frameOf(event, width, height) : null)
  }

  private show(text: string | null): void {
    if (text === this.shown) return
    this.shown = text
    this.onChange(text)
  }
}

/** A cue with no duration lasts until the next cue starts, within a limit. */
function endOf(cue: Cue, all: readonly Cue[]): number {
  if (Number.isFinite(cue.end)) return cue.end
  const next = all.find((c) => c.start > cue.start)
  return Math.min(next ? next.start : Infinity, cue.start + OPEN_ENDED_SECONDS)
}
