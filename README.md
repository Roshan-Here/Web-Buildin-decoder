# Web-Buildin-decoder

**A built-in video decoder for the web.** Play MKV, HEVC, AC-3, DTS, multi-track audio and
embedded subtitles in any modern browser, whatever the browser itself supports, under your own
player controls.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Browsers' own `<video>` plays MP4 and WebM with a handful of codecs, shows one audio track and
ignores subtitles inside the file. Web-Buildin-decoder decodes in the page instead (FFmpeg in
WebAssembly for the container and sound, WebCodecs for the picture with FFmpeg as the software
fallback, through [movi-player](https://github.com/mrujjwalg/movi-player)), and gives you a
small, typed API to build your own player on top: a media element that behaves like `<video>`,
track lists, caption text, chapters, timeline previews and picture in picture.

It reads files through a `ByteSource`: from any HTTP server that answers Range requests, a local
file, or your own storage (cloud APIs, IPFS, peer to peer), with a chunk cache that
reads ahead and cancels the read ahead on a seek.

Created by **[Roshan-Here](https://github.com/Roshan-Here)**.

## Contents

- [What it plays](#what-it-plays)
- [Install](#install)
- [Quick start](#quick-start)
- [Building a player](#building-a-player)
- [Reading files](#reading-files)
- [API](#api)
- [Bundlers, hosting and security headers](#bundlers-hosting-and-security-headers)
- [How it works](#how-it-works)
- [Development](#development)
- [Credits](#credits)
- [License](#license)

## What it plays

|               | Supported                                                         |
| ------------- | ----------------------------------------------------------------- |
| Containers    | MP4 / MOV, WebM, MKV, AVI, MPEG-TS                                |
| Video         | H.264, HEVC (H.265), VP9, AV1                                     |
| Audio         | AAC, AC-3, E-AC-3, DTS, TrueHD, Opus                              |
| Subtitles     | SRT, ASS/SSA, WebVTT, MP4 timed text (as text, drawn by your app) |
| Audio tracks  | Every track, switchable while playing                             |
| Also          | Chapters, timeline preview stills, picture in picture             |
| Not yet shown | Picture subtitles (PGS, VobSub, DVB): listed but not selectable   |

Where the device has no hardware decoder for the picture (HEVC on many PCs, for example), the
decoder switches to software decoding by itself and carries on from where it was.

**Cost:** about 1 MB of script and 2.3 MB of WebAssembly (both compressed), downloaded once
on the first video and then cached by the browser.

## Install

```sh
npm install web-buildin-decoder movi-player@0.4
```

`movi-player` is a peer dependency, pinned to 0.4.x because the decoder works with some of
its internals (see [How it works](#how-it-works)).

## Quick start

```html
<div id="stage" style="position: relative; aspect-ratio: 16 / 9; background: #000"></div>
<div id="captions"></div>
```

```ts
import { createBuiltinDecoder, httpSource } from 'web-buildin-decoder'

const decoder = await createBuiltinDecoder({
  host: document.getElementById('stage')!,
  source: await httpSource('https://example.com/movie.mkv'),
  key: 'movie.mkv',
})

decoder.onCaption((text) => {
  document.getElementById('captions')!.textContent = text ?? ''
})
decoder.onFailure(({ title, message }) => console.error(title, message))

decoder.media.addEventListener('loadedmetadata', () => void decoder.media.play())
```

A local file works the same way:

```ts
import { createBuiltinDecoder, fileSource } from 'web-buildin-decoder'

input.addEventListener('change', async () => {
  const file = input.files![0]!
  await createBuiltinDecoder({ host: stage, source: fileSource(file), key: file.name })
})
```

A complete example with play, seek, audio and subtitle menus is in
[`examples/basic`](examples/basic) (`npm run fixtures && npm run example`).

## Building a player

The decoder draws the picture only. Everything else is yours, through a `MediaEngine`:

```ts
const { media } = decoder // behaves like a <video>: play(), pause(), currentTime, duration,
// volume, muted, playbackRate, buffered, and the usual media events

media.addEventListener('timeupdate', () => render(media.currentTime, media.duration))

// Tracks
decoder.onTracks(() => {
  const audio = decoder.audioTracks() // { options: [{ id, label, language, detail, selectable }], selected }
  const subtitles = decoder.subtitleTracks()
  renderMenus(audio, subtitles)
})
decoder.selectAudio('2')
decoder.selectSubtitle('3') // or null to turn them off
decoder.setSubtitleDelay(-0.5) // show subtitles half a second earlier

// Chapters, read again on onTracks
const chapters = decoder.chapters() // [{ title, start, end }]

// Timeline previews: one request at a time
timeline.addEventListener('pointerenter', () => decoder.previews?.prepare())
const still = await decoder.previews?.frame(hoverSeconds) // Blob (an image) or null

// Picture in picture (Document Picture-in-Picture window)
const pip = await documentPictureInPicture.requestWindow()
const restore = decoder.showPictureIn(pip.document.body)
pip.addEventListener('pagehide', restore)

// System picture in picture with your own <video>: keep decoding while the tab is hidden
const stream = decoder.captureStream()
const release = decoder.keepPictureAlive()

decoder.destroy() // stops reading, frees the decoder and removes the element
```

Draw captions yourself from `onCaption`, in your own style and above your controls. Track
labels use the track's title, then its language name in the browser's language ("English",
"Englisch"), then "Track 1"; codec details read like "AC-3 5.1".

### Start fast

```ts
import { preloadDecoder } from 'web-buildin-decoder'

// Download and compile the decoder while the person is still choosing what to watch.
card.addEventListener('pointerenter', () => void preloadDecoder(), { once: true })
```

`httpSource()` also fetches a file's first chunks and its last one together as soon as it is
opened (the header, and the index Matroska and many MP4s keep at the end), so the decoder finds
them already downloaded.

### Resume and autoplay

```ts
await createBuiltinDecoder({ host, source, key, startAt: 754 }) // opens at 12:34, no jump
```

The decoder does not start by itself unless you pass `autoplay: true`. Calling
`media.play()` yourself after `loadedmetadata` lets you tell a refused autoplay apart (the
promise rejects) and, for example, play muted with a "Turn on sound" button.

### Choosing between this and the browser's `<video>`

The browser's own decoder is lighter on battery. `playability()` tells you before anything
downloads whether the browser can play a file itself:

```ts
import { playability, browserCanPlay } from 'web-buildin-decoder'

playability({ mimeType: 'video/x-matroska', fileName: 'film.x265.mkv' }, browserCanPlay)
// 'no' | 'maybe' | 'yes'
```

The `MediaEngine` interface is the same whichever decoder plays, so an app can implement a
second engine over `<video>` and switch without touching its controls.

## Reading files

Everything reads through a `ByteSource`:

```ts
interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  createSideReader?(): ByteSource
}
```

### `httpSource(url, options?)`

For any server that answers `Range` requests (static hosts, S3, R2, GCS, most CDNs).

| Option          | Default | What it does                                           |
| --------------- | ------- | ------------------------------------------------------ |
| `headers`       |         | Extra request headers, such as `Authorization`         |
| `credentials`   |         | `'include'` to send cookies to another origin          |
| `size`          | probed  | The file's size if you know it; saves one request      |
| `chunkSize`     | 1 MiB   | Bytes per request                                      |
| `cacheChunks`   | 32      | Chunks kept in memory                                  |
| `readAhead`     | 4       | Chunks downloaded ahead of playback                    |
| `concurrency`   | 2       | Read-ahead downloads at once                           |
| `prefetchStart` | `true`  | Fetch the head and tail of the file at once on opening |
| `fetch`         | `fetch` | Your own `fetch`, for signing requests or tests        |

On another origin the server must allow it by CORS and expose `Content-Range`
(`Access-Control-Expose-Headers: Content-Range`), unless you pass `size`. Pass
`isPermanent: isPermanentHttpError` to `createBuiltinDecoder` so a 404 stops at once instead
of being retried.

### `fileSource(blob)` and `bufferSource(bytes)`

A `File` or `Blob` (from `<input type="file">` or drag and drop), or bytes already in memory.

### Your own storage: `ChunkedSource`

For a backend that serves a file in pieces, give `ChunkedSource` a way to fetch one chunk and
it does the rest: an LRU cache, read ahead that a seek cancels, one download per chunk however
many readers want it, and a side reader for timeline previews.

Downloads are scheduled by who is waiting, since every download in flight shares one link:

| First | What                                 | How                                                                                            |
| ----- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1     | A chunk playback is waiting for      | Starts at once; nothing else starts until it arrives                                           |
| 2     | A chunk a timeline preview waits for | Starts at once; read ahead waits for it while playback has a couple of chunks in hand          |
| 3     | `prefetch` / `prefetchStart`         | In the order given, `concurrency` (default 2) at a time; not cancelled by reads                |
| 4     | Read ahead after each read           | Nearest first: one at a time while playback has nothing in hand, `concurrency` once it has one |

After a seek, the chunk the picture needs gets the link to itself instead of sharing it with
read ahead from where playback was, which is cancelled.

```ts
import { ChunkedSource, createBuiltinDecoder } from 'web-buildin-decoder'

const source = new ChunkedSource({
  size: fileSize,
  chunkSize: 512 * 1024,
  fetchChunk: async (index, chunkSize, signal) => {
    const response = await fetch(`/api/files/${id}/chunks/${index}?size=${chunkSize}`, { signal })
    return new Uint8Array(await response.arrayBuffer())
  },
})
source.prefetchStart() // the header and the index, before the decoder asks

await createBuiltinDecoder({ host, source, key: id })
```

## API

### `createBuiltinDecoder(options): Promise<MediaEngine>`

| Option             | Required | What it is                                                            |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `host`             | yes      | The element the picture fills                                         |
| `source`           | yes      | A `ByteSource`                                                        |
| `key`              | yes      | A stable id for the file, for caches and logs                         |
| `startAt`          |          | Seconds to open at                                                    |
| `autoplay`         |          | Start playing by itself (default `false`)                             |
| `isPermanent`      |          | `(error) => boolean`: read failures not worth retrying                |
| `messages`         |          | Your own text for labels and failures (see below)                     |
| `locale`           |          | Locale for language names; default the browser's                      |
| `wasmUrl`          |          | Where `movi.wasm` is served, if your bundler does not emit it         |
| `logLevel`         |          | movi-player's console logging: `'silent'`…`'debug'`, default `'warn'` |
| `blockRemoteFonts` |          | Stop movi-player loading a font from Google Fonts (default `true`)    |

### Other exports

| Export                                                    | What it is                                          |
| --------------------------------------------------------- | --------------------------------------------------- |
| `preloadDecoder(options?)`                                | Downloads and compiles the decoder ahead of time    |
| `configureLoader(options)`                                | Defaults for every decoder (`logLevel`, `wasmUrl`)  |
| `loadDecoder()`, `createDecoderElement(options?)`         | Lower level: the module, and a bare `<movi-player>` |
| `httpSource`, `fileSource`, `bufferSource`                | Ready-made `ByteSource`s                            |
| `ChunkedSource`                                           | Chunk cache with read ahead for your own backend    |
| `ByteSourceAdapter`                                       | Feeds a `ByteSource` to movi-player, with retries   |
| `HttpSourceError`, `isPermanentHttpError`                 | HTTP read failures                                  |
| `CaptionRenderer`, `packetText`, `isTextSubtitle`         | The subtitle renderer the decoder uses              |
| `playability`, `effectiveMimeType`, `browserCanPlay`      | Can the browser's own `<video>` play a file?        |
| `languageName`, `sameLanguage`, `describeCodec`           | "eng" → "English", "ac3", 6 → "AC-3 5.1"            |
| `defaultMessages`, `DecoderMessages`                      | The English text, to translate                      |
| `configureDiagnostics`, `diagnosticsReport`, `logDecoder` | The decoder's log, for bug reports                  |
| `Signal`, `setMedia`, and the `MediaEngine` types         | For building your own engine or player              |

### Translating

```ts
await createBuiltinDecoder({
  host,
  source,
  key,
  locale: 'de',
  messages: {
    didNotPlay: 'Dieses Video wurde nicht abgespielt',
    readFailed: (reason) => `Die Datei konnte nicht gelesen werden: ${reason}`,
    audioTrack: (n) => `Tonspur ${n}`,
    subtitleTrack: (n) => `Untertitel ${n}`,
  },
})
```

### Diagnostics

Warnings and errors go to the console with a `[decoder]` prefix. Everyday steps are logged too
with `configureDiagnostics({ verbose: true })` or `localStorage.debug = 'decoder'`. Send them
to your own logging with `configureDiagnostics({ sink })`, and attach `diagnosticsReport()` to
bug reports: it holds the browser, whether WebCodecs is there, and the last 200 steps.

For a quiet console on a live site, keep the log for bug reports but print nothing, and turn
movi-player's own logging off:

```ts
import { configureDiagnostics, configureLoader } from 'web-buildin-decoder'

if (import.meta.env.PROD) {
  configureDiagnostics({ sink: () => {} }) // still kept for diagnosticsReport()
  configureLoader({ logLevel: 'silent' })
}
```

## Bundlers, hosting and security headers

**Vite.** The production build emits `movi.wasm` by itself. In development, keep
movi-player out of dependency pre-bundling, which would lose the file:

```ts
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ['movi-player'] } })
```

**webpack 5 and Parcel 2** emit `movi.wasm` by themselves. **Other bundlers or a CDN:** copy
`node_modules/movi-player/dist/movi.wasm` to your site and pass `wasmUrl: '/movi.wasm'`.

Serve `movi.wasm` as `application/wasm` with a long cache lifetime; it never changes for a
given version.

**Content-Security-Policy.** The decoder needs WebAssembly, a worker from a `blob:` URL
(movi-player uses one as a timer that keeps playback smooth in background tabs), and `blob:`
images and media if you show timeline previews or use picture in picture:

```
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob:;
media-src 'self' blob:; connect-src 'self' <your video hosts>
```

No request goes anywhere but your `ByteSource`: the Google Fonts request movi-player would
make for its own controls is blocked by default (`blockRemoteFonts`).

## How it works

```
your controls ──► MediaEngine ──► <movi-player> (picture only, its controls off)
                                      │  FFmpeg/WASM demuxer + audio, WebCodecs/FFmpeg video
                                      ▼
                             ByteSourceAdapter  (retries, permanent failures)
                                      ▼
                     ByteSource: ChunkedSource cache ◄── httpSource / your backend
                                      ▲
               side reader (timeline previews; never moves the read ahead)
```

A few things the decoder handles so you do not have to:

- **Software decoding.** When the device has no hardware decoder for the picture, movi-player
  asks to switch to software decoding but, for a source adapter, never restarts. The decoder
  hands the file over again and resumes where playback was.
- **Previews that do not stall playback.** movi-player's keyframe-only preview decoder would
  read through playback's own reader, so every hovered position would cancel the read ahead.
  Previews get their own reader over the chunk cache instead, and the preview decoder is only
  started the first time the pointer reaches the timeline. A preview asked for while another
  is being made waits its turn rather than coming back empty.
- **Subtitles turned on mid-line.** Subtitle packets arrive with the stream, so turning
  subtitles on re-reads from the last keyframe (the bytes are in the cache) to pick up the line
  already on screen.
- **Picture in picture in a hidden tab.** movi-player skips decoding the picture while the tab
  is hidden; `showPictureIn` and `keepPictureAlive` tell it the picture is on screen elsewhere.
- **A quiet console.** movi-player's debug logging is turned down, and its "Unrecognized
  feature" warnings in Chrome are answered without asking.

## Development

```sh
npm install
npm run check          # types, formatting, unit tests, build
npm run fixtures       # test videos in examples/basic/media (needs ffmpeg with libx265)
npm run example        # the example page
npm run test:browser   # plays the test videos in headless Chromium and checks the results
```

The browser check plays an HEVC + AC-3 Matroska file with two audio tracks and two subtitle
tracks, and an H.264 one, and checks playback, track lists, subtitles, audio switching, seeking
and timeline previews. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Web-Buildin-decoder is written and maintained by
**[Roshan-Here](https://github.com/Roshan-Here)**.

You are free to use it in open source and commercial projects under the MIT License. The
licence asks you to keep the copyright notice in [LICENSE](LICENSE) with any copy of the code;
please also credit the project where you list your app's software, for example:

> Video decoding by [Web-Buildin-decoder](https://github.com/Roshan-Here/Web-Buildin-decoder) by Roshan-Here (MIT)

It stands on [movi-player](https://github.com/mrujjwalg/movi-player) by Ujjawal Kashyap
(Apache-2.0), [FFmpeg](https://ffmpeg.org) (LGPL 2.1) and
[dav1d](https://code.videolan.org/videolan/dav1d) (BSD 2-clause). See [NOTICE](NOTICE) for
what an app that ships them must include.

## License

[MIT](LICENSE) © 2026 Roshan-Here
