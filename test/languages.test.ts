import { describe, expect, it } from 'vitest'
import { describeCodec, languageName, sameLanguage } from '../src/languages.js'
import { defaultMessages, resolveMessages } from '../src/messages.js'

describe('languageName', () => {
  it('names the language in English when the locale is a tag Intl refuses', () => {
    expect(languageName('es', 'en-US@posix')).toBe('Spanish')
  })

  it('names three- and two-letter codes in the locale asked for', () => {
    expect(languageName('eng', 'en')).toBe('English')
    expect(languageName('en', 'en')).toBe('English')
    expect(languageName('ger', 'de')).toBe('Deutsch')
  })

  it('has nothing to say about undetermined or missing languages', () => {
    expect(languageName('und', 'en')).toBeNull()
    expect(languageName(null, 'en')).toBeNull()
  })
})

describe('sameLanguage', () => {
  it('matches the two codes of one language', () => {
    expect(sameLanguage('spa', 'es')).toBe(true)
    expect(sameLanguage('eng', 'fr')).toBe(false)
    expect(sameLanguage(null, 'en')).toBe(false)
  })
})

describe('describeCodec', () => {
  it('names codecs and channel layouts', () => {
    expect(describeCodec('ac3', 6)).toBe('AC-3 5.1')
    expect(describeCodec('aac', 2)).toBe('AAC stereo')
    expect(describeCodec('truehd', 8)).toBe('TrueHD 7.1')
    expect(describeCodec('opus', 3)).toBe('Opus 3 ch')
    expect(describeCodec('subrip')).toBe('SRT')
    expect(describeCodec(undefined)).toBeNull()
  })

  it('uses the messages it is given', () => {
    const messages = resolveMessages({ stereo: 'Stereo', timedText: 'Texte' })
    expect(describeCodec('aac', 2, messages)).toBe('AAC Stereo')
    expect(describeCodec('mov_text', undefined, messages)).toBe('Texte')
    expect(messages.didNotPlay).toBe(defaultMessages.didNotPlay)
  })
})
