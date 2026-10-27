// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { MoviElement } from 'movi-player'
import type * as MoviSlim from 'movi-player/element/slim'

type MoviModule = typeof MoviSlim

/** How much movi-player itself writes to the console. */
export type MoviLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export interface LoaderOptions {
  /**
   * Where `movi.wasm` (the FFmpeg WebAssembly, about 5.4 MB) is served from. Vite, webpack 5
   * and Parcel 2 emit it from the package by themselves, so this is only needed with other
   * bundlers or a CDN; copy `movi-player/dist/movi.wasm` there.
   */
  wasmUrl?: string
  /** movi-player's own console logging. Default `'warn'`. */
  logLevel?: MoviLogLevel
  /**
   * movi-player's own controls load the Inter typeface from Google Fonts. This decoder turns
   * those controls off, so by default the request is never made: it would tell Google about
   * every viewer and is blocked by most strict Content-Security-Policies. Default `true`.
   */
  blockRemoteFonts?: boolean
}

let loading: Promise<MoviModule> | null = null
let warming: Promise<void> | null = null

/**
 * Loads movi-player's slim build (about 1 MB compressed) and registers `<movi-player>`.
 * Only the first video pays for the download; afterwards it comes from memory.
 */
export function loadDecoder(): Promise<MoviModule> {
  loading ??= import('movi-player/element/slim')
    .then(async (module) => {
      await customElements.whenDefined('movi-player')
      return module
    })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

const LOG_LEVELS = {
  silent: 'SILENT',
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
} as const

/**
 * A `<movi-player>` with no controls of its own: a picture surface a custom player draws over.
 * Its constructor turns the library's logging up to debug, which floods the console and costs
 * time on every frame, so the level is set back here.
 */
export async function createDecoderElement(options: LoaderOptions = {}): Promise<MoviElement> {
  const movi = await loadDecoder()
  const element = document.createElement('movi-player') as MoviElement
  movi.Logger.setLevel(movi.LogLevel[LOG_LEVELS[options.logLevel ?? 'warn']])
  if (options.wasmUrl) element.setAttribute('wasmurl', options.wasmUrl)
  quieten(element, options.blockRemoteFonts ?? true)
  return element
}

/**
 * Two things movi-player 0.4 does for its own controls, which this decoder does not show, and
 * which only fill the console:
 *
 * - Its constructor queues (in the next animation frame) a `<style data-movi-font>` into its
 *   shadow root that `@import`s Inter from Google Fonts, unless one is there already. An empty
 *   one put there first, before that frame, keeps it out.
 * - Its audio output menu asks `document.featurePolicy.allowsFeature('speaker-selection')`,
 *   and Chrome, which has no such feature, logs "Unrecognized feature" each time. A feature
 *   the browser does not know is not restricted by policy, so it is answered here the way
 *   movi answers a browser without `featurePolicy` (allowed), without asking.
 */
function quieten(element: MoviElement, blockRemoteFonts: boolean): void {
  const root = element.shadowRoot
  if (blockRemoteFonts && root && !root.querySelector('style[data-movi-font]')) {
    const style = document.createElement('style')
    style.setAttribute('data-movi-font', '')
    root.appendChild(style)
  }
  // A private method in movi's types, so reached through a plain object view of the element.
  const host = element as unknown as { featureAllowed?: (feature: string) => boolean }
  const own = host.featureAllowed
  if (typeof own !== 'function') return
  host.featureAllowed = (feature: string) => {
    const policy = (document as Document & { featurePolicy?: { features?: () => string[] } })
      .featurePolicy
    const known = policy?.features?.()
    if (known && !known.includes(feature)) return true
    return own.call(element, feature)
  }
}

/**
 * Gets the decoder completely ready before a video needs it: its script, and its FFmpeg
 * WebAssembly downloaded, compiled and instantiated. movi-player keeps that instance for the
 * first player that opens a file, so a video started afterwards skips all of it. Call it while
 * the person is still choosing what to watch (on hover, on idle).
 *
 * Safe to call any number of times; a failure is forgotten so a later call can try again
 * (the decoder would load it itself anyway).
 */
export function preloadDecoder(options: LoaderOptions = {}): Promise<void> {
  warming ??= (async () => {
    const movi = await loadDecoder()
    // The loader learns where movi.wasm is from a player element's `wasmurl` attribute,
    // which it reads even when the element is never added to the page.
    await createDecoderElement(options)
    await movi.loadWasmModule()
  })().catch((error: unknown) => {
    warming = null
    console.warn('[decoder] could not prepare the built-in decoder in advance', error)
  })
  return warming
}
