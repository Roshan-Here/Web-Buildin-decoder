import type { Packet, SubtitleTrack } from 'movi-player'
import { describe, expect, it, vi } from 'vitest'
import { CaptionRenderer, isTextSubtitle, packetText } from '../src/captions.js'

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
