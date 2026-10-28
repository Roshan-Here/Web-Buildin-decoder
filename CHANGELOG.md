# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-28

### Changed

- `ChunkedSource` schedules downloads by who is waiting. A read playback waits for starts at
  once and holds back everything else until it arrives; prefetch and read ahead run in order,
  `concurrency` (now default 2) at a time, and read ahead goes one chunk at a time while
  playback has nothing in hand. A timeline preview's read goes before read ahead while playback
  has chunks to spare. On a measured 1.5 MB/s link, seeking to playing went from 3–4 s to under
  2 s, and the stalls after a seek all but disappeared.
- `prefetchStart(headChunks, tailChunks)` fetches the header first, then the end of the file,
  then the rest of the start.
- A timeline preview asked for while another is being made now waits its turn instead of
  answering `null`.

### Added

- `configureLoader(options)`: defaults (`logLevel`, `wasmUrl`, `blockRemoteFonts`) for every
  decoder, for example a silent console on a live site.

### Fixed

- `languageName()` names languages in English when the locale is a tag `Intl` refuses (such as
  `en-US@posix`, which some systems report), instead of answering with the bare code.

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

[0.2.0]: https://github.com/Roshan-Here/Web-Buildin-decoder/releases/tag/v0.2.0
[0.1.0]: https://github.com/Roshan-Here/Web-Buildin-decoder/releases/tag/v0.1.0
