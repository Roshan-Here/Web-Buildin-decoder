// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * The contract between a player's controls and whatever decodes the video. The built-in
 * decoder in this package implements it; an app can implement it a second time over the
 * browser's own `<video>` and switch between the two without touching its controls.
 */
export type EngineKind = 'builtin' | 'browser'

/** The media element surface both engines share; `<video>` and `<movi-player>` both have it. */
export interface MediaLike extends EventTarget {
  play(): Promise<void>
  pause(): void
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  readonly ended: boolean
  volume: number
  muted: boolean
  playbackRate: number
  readonly buffered: TimeRanges
}

/** What a player's controls change on the playing media. */
export type MediaSettings = Partial<
  Pick<MediaLike, 'currentTime' | 'volume' | 'muted' | 'playbackRate'>
>

/**
 * Changes playback settings on the media. Engines own their media objects, so components can
 * ask through here instead of writing to an object they received from elsewhere.
 */
export function setMedia(media: MediaLike, settings: MediaSettings): void {
  if (settings.currentTime !== undefined) media.currentTime = settings.currentTime
  if (settings.volume !== undefined) media.volume = settings.volume
  if (settings.muted !== undefined) media.muted = settings.muted
  if (settings.playbackRate !== undefined) media.playbackRate = settings.playbackRate
}

export interface TrackOption {
  id: string
  label: string
  /** The track's language code as the file states it, if it does. */
  language: string | null
  /** Codec and channels, for example "AC-3 5.1". */
  detail: string | null
  /** False for tracks this decoder cannot show, such as picture subtitles. */
  selectable: boolean
}

export interface TrackList {
  options: TrackOption[]
  selected: string | null
}

/** A chapter mark from the file: where it starts and ends, in seconds, and its name. */
export interface ChapterMark {
  title: string
  start: number
  /** 0 when the file does not say. */
  end: number
}

export interface EngineFailure {
  title: string
  message: string
}

export interface MediaEngine {
  readonly kind: EngineKind
  readonly media: MediaLike
  audioTracks(): TrackList
  subtitleTracks(): TrackList
  /** The file's own chapter marks, in seconds; read again when the tracks change. */
  chapters(): ChapterMark[]
  /** Shows the file's subtitles this many seconds later (earlier when negative). */
  setSubtitleDelay(seconds: number): void
  selectAudio(id: string): void
  selectSubtitle(id: string | null): void
  /** Track lists or selections changed. */
  onTracks(listener: () => void): () => void
  /** The caption text on screen changed; null when there is none. */
  onCaption(listener: (text: string | null) => void): () => void
  /** Playback failed and will not recover by itself. */
  onFailure(listener: (failure: EngineFailure) => void): () => void
  /**
   * A live stream of the picture, for the system's picture in picture. The built-in decoder
   * draws to a canvas, which can be captured. Null where unsupported.
   */
  captureStream(): MediaStream | null
  /** The engine's own `<video>`, when it has one (a browser engine), for picture in picture. */
  readonly video: HTMLVideoElement | null
  /**
   * Shows the moving picture inside `container`, which may belong to another window (a
   * Document Picture-in-Picture window), and keeps it moving while this tab is hidden. Returns
   * a function that brings the picture back.
   */
  showPictureIn(container: HTMLElement): () => void
  /**
   * Says the picture is on screen somewhere else (the system's picture in picture), so the
   * decoder keeps decoding it while this tab is hidden. Returns a function that ends that.
   */
  keepPictureAlive(): () => void
  /** Stills of the scene at a time, for the timeline; null where this engine has none. */
  readonly previews: PreviewSource | null
  destroy(): void
}

/** Stills of the video for the timeline, made by the engine that plays it. */
export interface PreviewSource {
  /** Gets ready for requests, for example when the pointer reaches the timeline. */
  prepare(): void
  /**
   * A still of the scene at `time` (seconds), usually the keyframe at or before it. Null when
   * none can be made. Callers keep one request in flight at a time.
   */
  frame(time: number): Promise<Blob | null>
}

/** A small typed event hub for engines. */
export class Signal<T extends unknown[]> {
  private readonly listeners = new Set<(...args: T) => void>()
  add(listener: (...args: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(...args: T): void {
    for (const listener of this.listeners) listener(...args)
  }
  clear(): void {
    this.listeners.clear()
  }
}
