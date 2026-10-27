// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * Web-Buildin-decoder: a built-in video decoder for the web that plays MKV, HEVC, AC-3, DTS and
 * the rest in any modern browser, with every audio and subtitle track, under your own controls.
 *
 * Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here). MIT licence.
 */
export { createBuiltinDecoder, type BuiltinDecoderOptions } from './decoder.js'
export {
  loadDecoder,
  preloadDecoder,
  createDecoderElement,
  type LoaderOptions,
  type MoviLogLevel,
} from './loader.js'

export type { ByteSource } from './byte-source.js'
export { ChunkedSource, DEFAULT_CHUNK_SIZE, type ChunkedSourceOptions } from './chunked-source.js'
export {
  httpSource,
  fileSource,
  bufferSource,
  HttpSourceError,
  isPermanentHttpError,
  type HttpSourceOptions,
} from './sources.js'
export { ByteSourceAdapter, type ByteSourceAdapterOptions } from './source-adapter.js'

export { CaptionRenderer, isTextSubtitle, packetText, type Cue } from './captions.js'
export {
  playability,
  effectiveMimeType,
  browserCanPlay,
  type Playability,
  type PlayabilityInput,
  type CanPlay,
} from './playability.js'
export { languageName, sameLanguage, describeCodec, defaultLocale } from './languages.js'
export { defaultMessages, type DecoderMessages } from './messages.js'
export {
  configureDiagnostics,
  logDecoder,
  diagnosticEntries,
  diagnosticsReport,
  clearDiagnostics,
  type DiagnosticEntry,
  type DiagnosticLevel,
  type DiagnosticsOptions,
} from './diagnostics.js'
export {
  Signal,
  setMedia,
  type EngineKind,
  type MediaLike,
  type MediaSettings,
  type MediaEngine,
  type TrackOption,
  type TrackList,
  type ChapterMark,
  type EngineFailure,
  type PreviewSource,
} from './types.js'
