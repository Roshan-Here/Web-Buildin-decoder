import type { Packet, SubtitleTrack } from 'movi-player'
import { describe, expect, it, vi } from 'vitest'
import { CaptionRenderer, isShownSubtitle, isTextSubtitle, packetText } from '../src/captions.js'
import { boxPixels, writeDisplaySet } from './picture-subs/pgs-writer.js'

const encode = (text: string) => new TextEncoder().encode(text)
const packet = (text: string, timestamp: number, duration: number): Packet => ({
  streamIndex: 3,
  keyframe: true,
  timestamp,
  dts: timestamp,
  duration,
  data: encode(text),
  isIdr: false,
  isRasl: false,
  disposable: false,
})
const track = (codec: string) =>
  ({ id: 3, type: 'subtitle', codec, subtitleType: 'text' }) as SubtitleTrack

describe('packetText', () => {
  it('drops SubRip tags and blank lines', () => {
    expect(packetText('subrip', encode('<i>Hello</i>\r\n\r\n<font color="red">there</font>'))).toBe(
      'Hello\nthere',
    )
  })

  it('reads the text field of a Matroska ASS event and removes overrides', () => {
    const event = '12,0,Default,,0,0,0,,{\\an8}Line one\\NLine, two'
    expect(packetText('ass', encode(event))).toBe('Line one\nLine, two')
  })

  it('reads mov_text with its length prefix', () => {
    const body = encode('Caption')
    const data = new Uint8Array(2 + body.length + 4)
    data[1] = body.length
    data.set(body, 2)
    expect(packetText('mov_text', data)).toBe('Caption')
  })

  it('knows which codecs are text', () => {
    expect(isTextSubtitle('subrip')).toBe(true)
    expect(isTextSubtitle('ASS')).toBe(true)
    expect(isTextSubtitle('hdmv_pgs_subtitle')).toBe(false)
  })
})

describe('CaptionRenderer', () => {
  it('reports the text on screen as time passes, and only when it changes', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('subrip'))
    renderer.pushPacket(packet('First', 1, 2))
    renderer.pushPacket(packet('Second', 4, 2))
    onChange.mockClear()

    renderer.render(0.5)
    renderer.render(1.5)
    renderer.render(1.6)
    renderer.render(3.5)
    renderer.render(4.5)
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['First', null, 'Second'])
  })

  it('shows overlapping cues together', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('subrip'))
    renderer.pushPacket(packet('Top', 1, 5))
    renderer.pushPacket(packet('Bottom', 2, 5))
    renderer.render(3)
    expect(onChange).toHaveBeenLastCalledWith('Top\nBottom')
  })

  it('keeps a cue without duration until the next one starts', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('subrip'))
    renderer.pushPacket(packet('Open', 1, 0))
    renderer.pushPacket(packet('Next', 3, 1))
    renderer.render(2.9)
    expect(onChange).toHaveBeenLastCalledWith('Open')
    renderer.render(3.1)
    expect(onChange).toHaveBeenLastCalledWith('Next')
  })

  it('applies the subtitle delay', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('subrip'))
    renderer.pushPacket(packet('Late', 1, 1))
    renderer.setDelay(2)
    renderer.render(1.5)
    expect(onChange).not.toHaveBeenLastCalledWith('Late')
    renderer.render(3.5)
    expect(onChange).toHaveBeenLastCalledWith('Late')
  })

  it('ignores packets sent twice after a seek and forgets on clear', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('subrip'))
    renderer.pushPacket(packet('Once', 1, 1))
    renderer.pushPacket(packet('Once', 1, 1))
    expect(renderer.size).toBe(1)
    renderer.render(1.5)
    renderer.clear()
    expect(renderer.size).toBe(0)
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('draws nothing for picture subtitles', () => {
    const onChange = vi.fn()
    const renderer = new CaptionRenderer(onChange)
    renderer.configure(track('hdmv_pgs_subtitle'))
    renderer.pushPacket(packet('not text', 1, 2))
    renderer.render(1.5)
    expect(renderer.size).toBe(0)
  })
})

describe('CaptionRenderer with picture subtitles', () => {
  const palette = new Map([
    [0, { r: 0, g: 0, b: 0, a: 0 }],
    [1, { r: 255, g: 255, b: 255, a: 255 }],
  ])
  const pgs = (time: number, shown: boolean): Packet => ({
    ...packet('', time, 0),
    data: writeDisplaySet({
      time,
      width: 1920,
      height: 1080,
      compositionNumber: 0,
      palette,
      objects: shown
        ? [{ x: 100, y: 900, width: 20, height: 10, pixels: boxPixels(20, 10, 1, 1) }]
        : [],
    }),
  })

  it('shows a PGS track as pictures, on the canvas the stream gives, and takes them away', () => {
    const onText = vi.fn()
    const onPicture = vi.fn()
    const renderer = new CaptionRenderer(onText, onPicture)
    renderer.configure({ ...track('hdmv_pgs_subtitle'), subtitleType: 'image' } as SubtitleTrack)
    renderer.pushPacket(pgs(1, true))
    renderer.pushPacket(pgs(3, false))
    onPicture.mockClear()
    renderer.render(0.5, 1280, 720)
    renderer.render(1.5, 1280, 720)
    renderer.render(2, 1280, 720)
    renderer.render(3.5, 1280, 720)
    expect(onPicture).toHaveBeenCalledTimes(2)
    const frame = onPicture.mock.calls[0]![0]
    expect(frame).toMatchObject({ canvasWidth: 1920, canvasHeight: 1080 })
    expect(frame.pictures[0]).toMatchObject({ x: 100, y: 900, width: 20, height: 10 })
    expect(onPicture.mock.calls[1]![0]).toBeNull()
    expect(onText).not.toHaveBeenCalledWith(expect.any(String))
  })

  it('moves picture subtitles with the subtitle delay, and drops them on a seek', () => {
    const onPicture = vi.fn()
    const renderer = new CaptionRenderer(vi.fn(), onPicture)
    renderer.configure(track('hdmv_pgs_subtitle'))
    renderer.pushPacket(pgs(1, true))
    renderer.setDelay(2)
    renderer.render(1.5)
    expect(onPicture).not.toHaveBeenCalled()
    renderer.render(3.2)
    expect(onPicture.mock.lastCall?.[0]).not.toBeNull()
    renderer.clear()
    expect(onPicture).toHaveBeenLastCalledWith(null)
    expect(renderer.size).toBe(0)
  })

  it('shows every text and picture codec, and no others', () => {
    for (const codec of ['subrip', 'ass', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'])
      expect(isShownSubtitle(codec)).toBe(true)
    expect(isShownSubtitle('dvb_teletext')).toBe(false)
  })
})
