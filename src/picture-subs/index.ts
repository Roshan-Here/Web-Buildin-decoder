// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import { DvbDecoder } from './dvb.js'
import type { PictureDecoder, PictureEvent, PictureFrame } from './frame.js'
import { PgsDecoder } from './pgs.js'
import { readVobSubHeader, VobSubDecoder } from './vobsub.js'
import { XSubDecoder } from './xsub.js'

export type { PictureFrame, SubPicture } from './frame.js'

/** The picture subtitle codecs read here, by the names FFmpeg (and so movi-player) gives them. */
const PICTURE_CODECS: Record<string, 'pgs' | 'vobsub' | 'dvb' | 'xsub'> = {
  hdmv_pgs_subtitle: 'pgs',
  pgssub: 'pgs',
  dvd_subtitle: 'vobsub',
  dvdsub: 'vobsub',
  dvb_subtitle: 'dvb',
  dvbsub: 'dvb',
  xsub: 'xsub',
}

export function isPictureSubtitle(codec: string): boolean {
  return codec.toLowerCase() in PICTURE_CODECS
}

/** A decoder for [codec], with the track's header ([extradata]); null for other codecs. */
export function pictureDecoderFor(codec: string, extradata?: Uint8Array): PictureDecoder | null {
  switch (PICTURE_CODECS[codec.toLowerCase()]) {
    case 'pgs':
      return new PgsDecoder()
    case 'vobsub':
      return new VobSubDecoder(readVobSubHeader(extradata))
    case 'dvb':
      return new DvbDecoder()
    case 'xsub':
      return new XSubDecoder()
    default:
      return null
  }
}

/** How long a screen with no end and nothing after it may stay up, at most. */
const OPEN_ENDED_MAX_S = 30
/** Screens this far behind the playhead are let go; a seek back sends them again. */
const KEEP_BEHIND_S = 60

/**
 * The screens of a picture track in time order, answering what shows at a moment: the last
 * screen begun by then, until its own end or the next screen (which may be a clearing one).
 */
export class PictureTimeline {
  private events: PictureEvent[] = []

  add(event: PictureEvent): void {
    // Packets come again after a seek: the newer copy of a screen replaces the older.
    const same = this.events.findIndex((e) => Math.abs(e.start - event.start) < 0.001)
    if (same >= 0) this.events[same] = event
    else {
      let at = this.events.length
      while (at > 0 && this.events[at - 1]!.start > event.start) at--
      this.events.splice(at, 0, event)
    }
  }

  /** The screen at [time], or null when nothing shows. */
  at(time: number): PictureEvent | null {
    let index = -1
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i]!.start <= time) index = i
      else break
    }
    if (index < 0) return null
    const event = this.events[index]!
    if (event.pictures.length === 0) return null
    const next = this.events[index + 1]
    const end = Math.min(
      event.end ?? Infinity,
      next ? next.start : event.end == null ? event.start + OPEN_ENDED_MAX_S : Infinity,
    )
    return time < end ? event : null
  }

  /** Lets go of screens long gone by [time]. */
  forgetBefore(time: number): void {
    let drop = 0
    while (drop + 1 < this.events.length && this.events[drop + 1]!.start < time - KEEP_BEHIND_S)
      drop++
    if (drop > 0) this.events.splice(0, drop)
  }

  clear(): void {
    this.events = []
  }

  get size(): number {
    return this.events.length
  }
}

/** The frame to draw for a screen, on the video's own size when the stream names none. */
export function frameOf(
  event: PictureEvent,
  videoWidth: number,
  videoHeight: number,
): PictureFrame {
  return {
    pictures: event.pictures,
    canvasWidth: event.canvasWidth || videoWidth,
    canvasHeight: event.canvasHeight || videoHeight,
  }
}
