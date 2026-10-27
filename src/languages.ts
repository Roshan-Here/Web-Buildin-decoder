// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import { defaultMessages, type DecoderMessages } from './messages.js'

/** Language names per display locale, one formatter for each locale asked for. */
const languageNamers = new Map<string, Intl.DisplayNames | null>()

function languageNames(locale: string): Intl.DisplayNames | null {
  let namer = languageNamers.get(locale)
  if (namer === undefined) {
    try {
      namer = new Intl.DisplayNames([locale, 'en'], { type: 'language' })
    } catch {
      namer = null
    }
    languageNamers.set(locale, namer)
  }
  return namer
}

/** The page's language, falling back to English. */
export function defaultLocale(): string {
  return (
    (typeof navigator !== 'undefined' && navigator.language) ||
    (typeof document !== 'undefined' && document.documentElement.lang) ||
    'en'
  )
}

/**
 * "eng" or "en" becomes "English" (in `locale`: "Englisch" in German); unknown codes come back
 * as they are, and "und" (undetermined) or nothing comes back as null.
 */
export function languageName(
  code: string | null | undefined,
  locale: string = defaultLocale(),
): string | null {
  if (!code || code === 'und') return null
  const normalised = ISO_639_2[code.toLowerCase()] ?? code
  try {
    return languageNames(locale)?.of(normalised) ?? code
  } catch {
    return code
  }
}

/** Matroska uses three-letter codes; Intl understands the two-letter ones better. */
const ISO_639_2: Record<string, string> = {
  eng: 'en',
  spa: 'es',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  jpn: 'ja',
  kor: 'ko',
  chi: 'zh',
  zho: 'zh',
  ara: 'ar',
  hin: 'hi',
  tam: 'ta',
  tel: 'te',
  mal: 'ml',
  kan: 'kn',
  ben: 'bn',
  mar: 'mr',
  urd: 'ur',
  tur: 'tr',
  pol: 'pl',
  ukr: 'uk',
  dut: 'nl',
  nld: 'nl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  ell: 'el',
  heb: 'he',
  ind: 'id',
  may: 'ms',
  msa: 'ms',
  tha: 'th',
  vie: 'vi',
  per: 'fa',
  fas: 'fa',
  cze: 'cs',
  ces: 'cs',
  hun: 'hu',
  rum: 'ro',
  ron: 'ro',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  slo: 'sk',
  slk: 'sk',
  fil: 'fil',
  tgl: 'tl',
}

/** Two codes for one language match: "eng" and "en", "spa" and "es". */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (c: string) => ISO_639_2[c.toLowerCase()] ?? c.toLowerCase()
  return norm(a) === norm(b)
}

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  dca: 'DTS',
  truehd: 'TrueHD',
  mlp: 'MLP',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  mp2: 'MP2',
  flac: 'FLAC',
  subrip: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
}

/** A codec and channel count as people read them: "ac3", 6 becomes "AC-3 5.1". */
export function describeCodec(
  codec: string | undefined,
  channels?: number,
  messages: DecoderMessages = defaultMessages,
): string | null {
  if (!codec) return null
  const lower = codec.toLowerCase()
  const name =
    lower === 'mov_text' ? messages.timedText : (CODEC_NAMES[lower] ?? codec.toUpperCase())
  if (!channels) return name
  const layout =
    channels === 1
      ? messages.mono
      : channels === 2
        ? messages.stereo
        : channels === 6
          ? '5.1'
          : channels === 8
            ? '7.1'
            : messages.channels(channels)
  return `${name} ${layout}`
}
