# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-27

First release.

### Added

- `createBuiltinDecoder()`: plays MP4, WebM, MKV, AVI and MPEG-TS with H.264, HEVC, VP9 and AV1
  video and AAC, AC-3, E-AC-3, DTS, TrueHD and Opus sound, in the page, under your own controls.
- Audio track switching, text subtitles (SRT, ASS/SSA, WebVTT, MP4 timed text) delivered as
  caption text, subtitle delay, chapters, timeline preview stills, picture in picture helpers.
- Automatic switch to software decoding where the device has no hardware decoder for the
  picture, resuming where playback was.
- `httpSource()`, `fileSource()` and `bufferSource()`, plus the `ByteSource` interface for any
  other storage.
- `ChunkedSource`: an LRU chunk cache with read ahead that a seek cancels, prefetch of a file's
  head and tail, and a side reader so timeline previews never disturb playback.
- `ByteSourceAdapter` with retries and backoff, and permanent-failure detection.
- `preloadDecoder()` to download and compile the decoder before the first video.
- `playability()` to decide between this decoder and the browser's own `<video>`.
- Replaceable English text (`messages`), language names in any locale, and an in-memory
  diagnostics log with `diagnosticsReport()`.

[0.1.0]: https://github.com/Roshan-Here/Web-Buildin-decoder/releases/tag/v0.1.0
