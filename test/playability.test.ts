import { describe, expect, it } from 'vitest'
import { effectiveMimeType, playability, type CanPlay } from '../src/playability.js'

/** Roughly Chrome on a machine without an HEVC decoder. */
const chrome: CanPlay = (type) => {
  if (type.includes('hvc1')) return ''
  if (type.startsWith('video/mp4') || type.startsWith('video/webm')) return 'probably'
  if (type === 'video/x-matroska') return 'maybe'
  return ''
}

describe('effectiveMimeType', () => {
  it('uses the extension when the backend sends a generic type', () => {
    expect(effectiveMimeType({ mimeType: 'application/octet-stream', fileName: 'Film.MKV' })).toBe(
      'video/x-matroska',
    )
  })
  it('keeps a video type as it is', () => {
    expect(effectiveMimeType({ mimeType: 'video/mp4', fileName: 'a.mkv' })).toBe('video/mp4')
  })
})

describe('playability', () => {
  it('plays MP4 and WebM', () => {
    expect(playability({ mimeType: 'video/mp4', fileName: 'a.mp4' }, chrome)).toBe('yes')
    expect(playability({ mimeType: 'video/webm', fileName: null }, chrome)).toBe('yes')
  })
  it('flags HEVC when the browser has no decoder', () => {
    expect(playability({ mimeType: 'video/mp4', fileName: 'Show.S01E01.x265.mp4' }, chrome)).toBe(
      'no',
    )
    expect(playability({ mimeType: 'video/mp4', fileName: null, codec: 'hevc' }, chrome)).toBe('no')
  })
  it('is unsure about Matroska with ordinary codecs', () => {
    expect(playability({ mimeType: 'video/x-matroska', fileName: 'a.mkv' }, chrome)).toBe('no')
    expect(playability({ mimeType: 'video/x-matroska', fileName: 'a.mkv' }, () => '')).toBe('maybe')
  })
  it('rejects files that are not video', () => {
    expect(playability({ mimeType: 'application/zip', fileName: 'a.zip' }, chrome)).toBe('no')
  })
})
