import { describe, expect, it } from 'vitest'
import type { PictureEvent } from '../../src/picture-subs/frame.js'
import {
  frameOf,
  isPictureSubtitle,
  pictureDecoderFor,
  PictureTimeline,
} from '../../src/picture-subs/index.js'

const picture = { x: 0, y: 0, width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) }
const event = (start: number, end: number | null, shown = true): PictureEvent => ({
  start,
  end,
  pictures: shown ? [picture] : [],
  canvasWidth: 0,
  canvasHeight: 0,
})

describe('picture subtitles', () => {
  it('knows the picture codecs by every name FFmpeg gives them', () => {
    for (const codec of ['hdmv_pgs_subtitle', 'PGSSUB', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle'])
      expect(isPictureSubtitle(codec)).toBe(true)
    expect(isPictureSubtitle('subrip')).toBe(false)
    expect(isPictureSubtitle('dvb_teletext')).toBe(false)
    expect(pictureDecoderFor('subrip')).toBeNull()
    expect(pictureDecoderFor('hdmv_pgs_subtitle')).not.toBeNull()
  })

  it('shows each screen until its end or the next one, and nothing after a clearing one', () => {
    const timeline = new PictureTimeline()
    const first = event(1, null)
    const second = event(5, 6)
    timeline.add(second)
    timeline.add(event(3, null, false))
    timeline.add(first)
    expect(timeline.at(0.5)).toBeNull()
    expect(timeline.at(1)).toBe(first)
    expect(timeline.at(2.9)).toBe(first)
    expect(timeline.at(3.5)).toBeNull()
    expect(timeline.at(5.5)).toBe(second)
    expect(timeline.at(6.1)).toBeNull()
  })

  it('keeps a screen with no end up a while at most when nothing follows it', () => {
    const timeline = new PictureTimeline()
    timeline.add(event(10, null))
    expect(timeline.at(39)).not.toBeNull()
    expect(timeline.at(41)).toBeNull()
  })

  it('takes a screen sent again once, and lets old ones go', () => {
    const timeline = new PictureTimeline()
    timeline.add(event(1, 2))
    timeline.add(event(1, 2))
    expect(timeline.size).toBe(1)
    for (let t = 2; t < 200; t += 10) timeline.add(event(t, t + 1))
    timeline.forgetBefore(180)
    expect(timeline.size).toBeLessThan(10)
    expect(timeline.at(192.5)).not.toBeNull()
  })

  it('draws on the video size when the stream does not give its own', () => {
    expect(frameOf(event(0, null), 1280, 720)).toMatchObject({
      canvasWidth: 1280,
      canvasHeight: 720,
    })
    expect(
      frameOf({ ...event(0, null), canvasWidth: 1920, canvasHeight: 1080 }, 1280, 720),
    ).toMatchObject({ canvasWidth: 1920, canvasHeight: 1080 })
  })
})
