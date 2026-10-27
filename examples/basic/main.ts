import {
  createBuiltinDecoder,
  fileSource,
  httpSource,
  isPermanentHttpError,
  preloadDecoder,
  type ByteSource,
  type MediaEngine,
} from '../../src/index.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const stage = $<HTMLDivElement>('stage')
const captions = $<HTMLDivElement>('captions')
const play = $<HTMLButtonElement>('play')
const seek = $<HTMLInputElement>('seek')
const time = $<HTMLSpanElement>('time')
const audio = $<HTMLSelectElement>('audio')
const subtitles = $<HTMLSelectElement>('subtitles')
const status = $<HTMLParagraphElement>('status')

let decoder: MediaEngine | null = null

// Fetch and compile the decoder while the person is still choosing a file.
void preloadDecoder()

$<HTMLInputElement>('file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void open(fileSource(file), file.name)
})
$<HTMLButtonElement>('open').addEventListener('click', async () => {
  const url = $<HTMLInputElement>('url').value.trim()
  if (!url) return
  try {
    void open(await httpSource(url), url)
  } catch (error) {
    status.textContent = String(error)
  }
})

async function open(source: ByteSource, key: string) {
  decoder?.destroy()
  captions.textContent = ''
  status.textContent = 'Opening…'
  decoder = await createBuiltinDecoder({
    host: stage,
    source,
    key,
    isPermanent: isPermanentHttpError,
  })
  stage.append(captions) // keep captions above the picture
  const { media } = decoder

  decoder.onCaption((text) => (captions.textContent = text ?? ''))
  decoder.onFailure((failure) => (status.textContent = `${failure.title}: ${failure.message}`))
  decoder.onTracks(() => renderTracks(decoder!))

  media.addEventListener('loadedmetadata', () => {
    seek.max = String(media.duration)
    seek.disabled = play.disabled = false
    status.textContent = 'Ready.'
    void media.play().catch(() => (status.textContent = 'Press Play to start.'))
  })
  media.addEventListener('timeupdate', () => {
    seek.value = String(media.currentTime)
    time.textContent = `${clock(media.currentTime)} / ${clock(media.duration)}`
  })
  media.addEventListener('play', () => (play.textContent = 'Pause'))
  media.addEventListener('pause', () => (play.textContent = 'Play'))
}

play.addEventListener('click', () => {
  const media = decoder?.media
  if (!media) return
  if (media.paused) void media.play()
  else media.pause()
})
seek.addEventListener('change', () => {
  if (decoder) decoder.media.currentTime = Number(seek.value)
})
audio.addEventListener('change', () => decoder?.selectAudio(audio.value))
subtitles.addEventListener('change', () => decoder?.selectSubtitle(subtitles.value || null))

function renderTracks(engine: MediaEngine) {
  const a = engine.audioTracks()
  audio.replaceChildren(
    ...a.options.map((o) => new Option(o.detail ? `${o.label} (${o.detail})` : o.label, o.id)),
  )
  if (a.selected) audio.value = a.selected
  const s = engine.subtitleTracks()
  subtitles.replaceChildren(
    new Option('Off', ''),
    ...s.options.map((o) => {
      const option = new Option(o.detail ? `${o.label} (${o.detail})` : o.label, o.id)
      option.disabled = !o.selectable
      return option
    }),
  )
  subtitles.value = s.selected ?? ''
}

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// For the automated check in test/browser.mjs.
Object.assign(globalThis, { __decoder: () => decoder })
