// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { MoviElement, MoviPlayer } from 'movi-player'
import type { ByteSource } from './byte-source.js'
import { CaptionRenderer, isTextSubtitle } from './captions.js'
import { logDecoder } from './diagnostics.js'
import { describeCodec, languageName } from './languages.js'
import { createDecoderElement, type LoaderOptions } from './loader.js'
import { resolveMessages, type DecoderMessages } from './messages.js'
import { ByteSourceAdapter } from './source-adapter.js'
import {
  Signal,
  type EngineFailure,
  type MediaEngine,
  type MediaLike,
  type TrackList,
} from './types.js'

export interface BuiltinDecoderOptions extends LoaderOptions {
  /** The element the picture is drawn into; the decoder fills it. */
  host: HTMLElement
  /** Where the file's bytes come from: `httpSource()`, `fileSource()` or your own. */
  source: ByteSource
  /** Stable id of the file, for the decoder's caches and the logs. */
  key: string
  /** Read failures that will never succeed; playback stops at once on these. */
  isPermanent?: (error: unknown) => boolean
  /** Seconds to open at. The decoder seeks there before the first frame, so nothing jumps. */
  startAt?: number
  /** Start playing by itself once it can. Default `false`: call `media.play()` yourself. */
  autoplay?: boolean
  /** Text shown to people (track labels, failures). English by default. */
  messages?: Partial<DecoderMessages>
  /** Locale for language names ("English", "Englisch"). Default: the browser's language. */
  locale?: string
}

interface ErrorDisplay {
  title?: string | null
  message?: string | null
  canTrySoftware?: boolean
}

/**
 * The built-in decoder: video decoding in the page (FFmpeg in WebAssembly for the container
 * and sound, WebCodecs or FFmpeg for the picture, through movi-player), so every common format
 * plays, with its audio and subtitle tracks, whatever the browser itself supports. It draws
 * the picture only, so you can draw your own controls over it.
 *
 * Plays MP4, WebM, MKV, AVI and MPEG-TS; H.264, HEVC, VP9 and AV1; AAC, AC-3, E-AC-3, DTS,
 * TrueHD and Opus; SRT, ASS/SSA, WebVTT and MP4 text subtitles.
 */
export async function createBuiltinDecoder(options: BuiltinDecoderOptions): Promise<MediaEngine> {
  const messages = resolveMessages(options.messages)
  const nameOf = (code: string | null | undefined) => languageName(code, options.locale)
  const element = await createDecoderElement(options)
  // No autoplay attribute by default: the app starts playback itself once the first frame is
  // ready, so it can tell a refused autoplay apart and offer the sound.
  if (options.autoplay) element.setAttribute('autoplay', '')
  element.setAttribute('playsinline', '')
  element.setAttribute('nohotkeys', '')
  element.setAttribute('noerrorscreen', '')
  element.setAttribute('preload', 'auto')
  if (options.startAt && options.startAt > 0)
    element.setAttribute('startat', String(options.startAt))
  element.style.display = 'block'
  element.style.width = '100%'
  element.style.height = '100%'

  const tracksChanged = new Signal<[]>()
  const captionChanged = new Signal<[string | null]>()
  const failed = new Signal<[EngineFailure]>()
  const cleanups: Array<() => void> = []
  const on = (type: string, handler: (event: Event) => void) => {
    element.addEventListener(type, handler)
    cleanups.push(() => element.removeEventListener(type, handler))
  }

  const captions = new CaptionRenderer((text) => captionChanged.emit(text))
  element.setSubtitleRenderer(captions)

  let wantedSubtitle: number | null = null
  /** Seconds the subtitles are moved by, kept for a player rebuilt by a decoding restart. */
  let wantedDelay = 0
  let triedSoftware = false
  let destroyed = false
  const player = (): MoviPlayer | null =>
    (element as MoviElement & { player: MoviPlayer | null }).player

  /**
   * How many places show the picture outside this tab (a picture-in-picture window, the
   * system's picture in picture). While there is one, the decoder must keep decoding the
   * picture when the tab is hidden: by default movi-player drops video frames in a hidden tab
   * (nobody can see them) unless `isPiPActive` is set, which it only sets for its own PiP
   * window. Without this a picture-in-picture window freezes on its last frame as soon as the
   * person switches tabs. A software decoding restart builds a new player, so this is applied
   * again on each load.
   */
  let pictureHolds = 0
  const applyPictureHolds = () => {
    const p = player()
    if (p) p.isPiPActive = pictureHolds > 0
  }
  const keepPictureAlive = () => {
    pictureHolds++
    applyPictureHolds()
    let released = false
    return () => {
      if (released) return
      released = true
      pictureHolds--
      applyPictureHolds()
    }
  }

  on('loadedmetadata', () => {
    const p = player()
    logDecoder('opened', {
      duration: element.duration,
      video: p?.getVideoTracks().map((t) => `${t.codec} ${t.width}x${t.height}`),
      audio: p?.getAudioTracks().map((t) => `${t.codec} ${t.channels}ch ${t.language ?? ''}`),
      subtitles: p?.getSubtitleTracks().map((t) => `${t.codec} ${t.language ?? ''}`),
    })
    // A software decoding restart rebuilds the player; keep the subtitles chosen before it,
    // the picture alive where it is shown outside the tab, and previews off playback's reader.
    if (wantedSubtitle !== null) void p?.selectSubtitleTrack(wantedSubtitle)
    if (wantedDelay !== 0) p?.setSubtitleDelay(wantedDelay)
    applyPictureHolds()
    if (previewsWanted) routePreviewReads()
    tracksChanged.emit()
  })
  on('trackschange', () => tracksChanged.emit())
  on('audiotrackchange', () => tracksChanged.emit())
  on('errordisplay', (event) => {
    const detail = (event as CustomEvent<ErrorDisplay>).detail ?? {}
    if (detail.canTrySoftware && !triedSoftware) {
      // No hardware decoder for this picture (HEVC on many PCs): decode it in software.
      triedSoftware = true
      logDecoder('no hardware decoder, switching to software decoding', detail, 'warn')
      // The restart rebuilds the decoder from the start of the file without the `startat`
      // seek (the refusal comes before it), so go back to where playback should be.
      const resumeAt = Math.max(options.startAt ?? 0, element.currentTime)
      void element.enableSoftwareDecoding().then(() => {
        if (destroyed) return
        // movi-player rebuilds its decoder here only for a source given as a URL: with a
        // source adapter it tears the player down and never starts another, which leaves the
        // video on a spinner for good on machines without a hardware decoder for it. Hand the
        // adapter over again in that case; the `sw` attribute it has just set makes the new
        // player decode in software. (Where the player had already fallen back to software by
        // itself, movi keeps it and nothing needs doing.)
        if (!player()) {
          logDecoder('starting the software decoder', null, 'warn')
          adapter = openAdapter()
          element.sourceAdapter = adapter
        }
        if (resumeAt > 1 && element.currentTime < resumeAt - 1) {
          logDecoder('resuming after the switch', { at: resumeAt })
          element.currentTime = resumeAt
        }
      })
      return
    }
    logDecoder('failed', { ...detail, lastReadError: adapter.lastError?.message ?? null }, 'error')
    failed.emit({
      title: detail.title || messages.didNotPlay,
      message: adapter.lastError
        ? messages.readFailed(adapter.lastError.message)
        : detail.message || messages.decoderStopped,
    })
  })

  const adapters: ByteSourceAdapter[] = []
  const openAdapter = () => {
    const opened = new ByteSourceAdapter(options.source, {
      key: options.key,
      isPermanent: options.isPermanent,
      onRetry: (error, attempt) => logDecoder('read failed, retrying', { attempt, error }, 'warn'),
    })
    adapters.push(opened)
    return opened
  }
  /** Playback's reader; a new one only if the decoder has to be handed the file again. */
  let adapter = openAdapter()

  // Timeline previews. movi-player makes them with a second, keyframe-only decoder, but for a
  // source adapter it reads through the very adapter playback uses. A chunk cache with read
  // ahead treats every read as the new playhead, so each hovered position would cancel
  // playback's read ahead, start a new one there and push the chunks about to be played out
  // of the cache. The preview decoder gets its own adapter over a side reader instead. The
  // player looks its reader up on `thumbnailSource` at each read, so assigning playback's
  // adapter there is where the side one is swapped in.
  const sideReader = options.source.createSideReader?.() ?? null
  const previewAdapters: ByteSourceAdapter[] = []
  const routed = new WeakSet<object>()
  let previewsWanted = false
  const routePreviewReads = () => {
    const p = player() as unknown as Record<string, unknown> | null
    if (!p || !sideReader || routed.has(p)) return
    routed.add(p)
    let current: unknown = p.thumbnailSource ?? null
    Object.defineProperty(p, 'thumbnailSource', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: unknown) => {
        if (value === adapter) {
          // A fresh one per pipeline: the player closes its preview reader when it tears
          // the pipeline down, and builds another after a software decoding restart.
          const own = new ByteSourceAdapter(sideReader, {
            key: options.key,
            isPermanent: options.isPermanent,
          })
          previewAdapters.push(own)
          current = own
        } else current = value
      },
    })
  }

  options.host.appendChild(element)
  // The element starts loading when an adapter is assigned while it is in the document.
  element.sourceAdapter = adapter
  logDecoder('loading', { key: options.key, size: options.source.size })

  const media = element as unknown as MediaLike
  const capture = (): MediaStream | null => {
    try {
      return element.captureStream(30)
    } catch (error) {
      logDecoder('picture capture failed', error, 'warn')
      return null
    }
  }

  return {
    kind: 'builtin',
    media,
    audioTracks(): TrackList {
      const p = player()
      const tracks = p?.getAudioTracks() ?? []
      const enabled = element.audioTracks.find((t) => t.enabled)
      return {
        options: tracks.map((track, i) => ({
          id: String(track.id),
          label: track.label || nameOf(track.language) || messages.audioTrack(i + 1),
          language: track.language ?? null,
          detail: describeCodec(track.codec, track.channels, messages),
          selectable: true,
        })),
        selected:
          enabled?.trackId != null
            ? String(enabled.trackId)
            : tracks[0]
              ? String(tracks[0].id)
              : null,
      }
    },
    setSubtitleDelay(seconds) {
      wantedDelay = seconds
      try {
        player()?.setSubtitleDelay(seconds)
      } catch {
        // Not open yet: applied when it opens.
      }
    },
    chapters() {
      try {
        return (player()?.getMediaInfo()?.chapters ?? []).map((c) => ({
          title: c.title ?? '',
          start: c.start,
          end: c.end ?? 0,
        }))
      } catch {
        return []
      }
    },
    subtitleTracks(): TrackList {
      const tracks = player()?.getSubtitleTracks() ?? []
      return {
        options: tracks.map((track, i) => ({
          id: String(track.id),
          label: track.label || nameOf(track.language) || messages.subtitleTrack(i + 1),
          language: track.language ?? null,
          detail: isTextSubtitle(track.codec)
            ? describeCodec(track.codec, undefined, messages)
            : messages.codecUnsupported(describeCodec(track.codec, undefined, messages) ?? ''),
          selectable: isTextSubtitle(track.codec),
        })),
        selected: wantedSubtitle === null ? null : String(wantedSubtitle),
      }
    },
    selectAudio(id) {
      const ok = player()?.selectAudioTrack(Number(id)) ?? false
      logDecoder('audio track', { id, ok })
      tracksChanged.emit()
    },
    selectSubtitle(id) {
      wantedSubtitle = id === null ? null : Number(id)
      captions.clear()
      void player()
        ?.selectSubtitleTrack(wantedSubtitle)
        .then((ok) => {
          logDecoder('subtitle track', { id, ok })
          // Subtitle packets come with the stream as it is read, so a line already under way
          // when subtitles are turned on would be missed. Reading again from the keyframe
          // before the playhead (the bytes are in the cache) picks up lines that started since.
          const at = element.currentTime
          if (ok && wantedSubtitle !== null && at > 0) element.currentTime = at
        })
      tracksChanged.emit()
    },
    onTracks: (listener) => tracksChanged.add(listener),
    onCaption: (listener) => captionChanged.add(listener),
    onFailure: (listener) => failed.add(listener),
    captureStream: () => capture(),
    video: null,
    showPictureIn(container) {
      const stream = capture()
      if (!stream) {
        logDecoder('no picture to show in picture in picture', null, 'warn')
        return () => undefined
      }
      const release = keepPictureAlive()
      const doc = container.ownerDocument
      const video = doc.createElement('video')
      video.muted = true
      video.playsInline = true
      video.setAttribute('aria-hidden', 'true')
      video.style.cssText =
        'display:block;width:100%;height:100%;object-fit:contain;background:#000'
      video.srcObject = stream
      container.append(video)
      void video
        .play()
        .catch((error: unknown) => logDecoder('picture in picture did not start', error, 'warn'))
      let restored = false
      return () => {
        if (restored) return
        restored = true
        release()
        for (const track of stream.getTracks()) track.stop()
        video.srcObject = null
        video.remove()
      }
    },
    keepPictureAlive,
    previews: {
      prepare() {
        if (previewsWanted) return
        previewsWanted = true
        routePreviewReads()
        // The `thumb` attribute switches movi-player's preview decoder on. It is set only once
        // the person reaches the timeline, so videos nobody scrubs never pay for the second
        // decoder (its own WebAssembly instance and FFmpeg context).
        element.setAttribute('thumb', '')
      },
      async frame(time) {
        this.prepare()
        const p = player()
        if (!p) return null
        try {
          // Queued behind a still the player is already making (its own warm-up, or the last
          // one asked for) instead of being turned away with nothing: an empty answer reads as
          // "no picture at this time", and that stretch would never get one.
          return await p.getPreviewFrame(Math.max(0, time), null, true)
        } catch (error) {
          logDecoder('preview failed', error, 'warn')
          return null
        }
      },
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const cleanup of cleanups) cleanup()
      tracksChanged.clear()
      captionChanged.clear()
      failed.clear()
      element.remove()
      for (const opened of adapters) opened.close()
      for (const own of previewAdapters) own.close()
    },
  }
}
