// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { Packet, SubtitleRenderer, SubtitleTrack } from 'movi-player'

export interface Cue {
  start: number
  end: number
  text: string
}

/** Text subtitle codecs this renderer reads. Picture ones (PGS, VobSub, DVB) are not text. */
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

/**
 * movi-player's pluggable subtitle renderer, kept to what a custom player needs: it collects the
 * cues of the selected text track and reports the text that should be on screen, so your
 * player draws captions itself, in its own style and above its own controls.
 */
export class CaptionRenderer implements SubtitleRenderer {
  private codec = 'subrip'
  private cues: Cue[] = []
  private delay = 0
  private shown: string | null = null
  private readonly onChange: (text: string | null) => void

  constructor(onChange: (text: string | null) => void) {
    this.onChange = onChange
  }

  configure(track: SubtitleTrack): void {
    this.codec = track.codec
    this.reset()
  }

  pushPacket(packet: Packet): void {
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

  render(mediaTime: number): void {
    const t = mediaTime - this.delay
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

  /** The cues currently held, for tests. */
  get size(): number {
    return this.cues.length
  }

  private reset(): void {
    this.cues = []
    this.show(null)
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
