// Plays the test videos in headless Chromium through the example page and checks that the
// picture moves, the tracks are listed, subtitles show, audio switches, seeking and timeline
// previews work. Run `npm run fixtures` first; needs `npx playwright install chromium`.
import { chromium } from 'playwright'
import { createServer } from 'vite'

const files = ['sample-hevc-ac3.mkv', 'sample-h264.mkv']
const server = await createServer({
  root: 'examples/basic',
  configFile: 'examples/basic/vite.config.ts',
  server: { port: 5199 },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`)
  if (!ok) failures++
}

try {
  for (const file of files) {
    console.log(file)
    const page = await browser.newPage()
    await page.goto('http://localhost:5199/')
    await page.fill('#url', `/media/${file}`)
    await page.click('#open')
    const playing = await page
      .waitForFunction(() => (globalThis.__decoder?.()?.media.currentTime ?? 0) > 2, null, {
        timeout: 60_000,
      })
      .then(
        () => true,
        () => false,
      )
    check(playing, 'plays')
    const tracks = await page.evaluate(() => {
      const d = globalThis.__decoder()
      return { audio: d.audioTracks(), subs: d.subtitleTracks() }
    })
    check(
      tracks.audio.options.length > 0,
      `lists audio: ${tracks.audio.options.map((o) => `${o.label} (${o.detail})`).join(', ')}`,
    )
    if (tracks.subs.options.length > 0) {
      await page.selectOption('#subtitles', tracks.subs.options[0].id)
      const caption = await page
        .waitForFunction(() => document.querySelector('#captions').textContent.length > 0, null, {
          timeout: 15_000,
        })
        .then(
          () => page.textContent('#captions'),
          () => '',
        )
      check(caption.length > 0, `shows subtitles: "${caption}"`)
    }
    if (tracks.audio.options.length > 1) {
      const id = tracks.audio.options[1].id
      await page.selectOption('#audio', id)
      await page.waitForTimeout(1000)
      const selected = await page.evaluate(() => globalThis.__decoder().audioTracks().selected)
      check(selected === id, 'switches audio track')
    }
    await page.evaluate(() => (globalThis.__decoder().media.currentTime = 20))
    await page.waitForTimeout(2500)
    const at = await page.evaluate(() => globalThis.__decoder().media.currentTime)
    check(at >= 20, `seeks (now at ${at.toFixed(1)} s)`)
    const preview = await page.evaluate(
      async () => (await globalThis.__decoder().previews.frame(10))?.size ?? 0,
    )
    check(preview > 0, `makes timeline previews (${preview} bytes)`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('All browser checks passed')
