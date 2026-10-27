// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * Every piece of text the decoder can put in front of a person: track labels, codec details and
 * failure messages. English by default; pass your own (all or some) to translate them.
 */
export interface DecoderMessages {
  /** Title of a failure that stopped playback. */
  didNotPlay: string
  /** Message when the decoder stopped without saying why. */
  decoderStopped: string
  /** Message when reading the file failed, with the reason the source gave. */
  readFailed: (reason: string) => string
  /** Label of an audio track that has neither a name nor a language. */
  audioTrack: (number: number) => string
  /** Label of a subtitle track that has neither a name nor a language. */
  subtitleTrack: (number: number) => string
  /** Detail of a subtitle track this decoder cannot draw, such as PGS. */
  codecUnsupported: (codec: string) => string
  /** Name of the MP4 (3GPP) timed text subtitle codec. */
  timedText: string
  mono: string
  stereo: string
  /** Channel count for layouts without a common name. */
  channels: (count: number) => string
}

export const defaultMessages: DecoderMessages = {
  didNotPlay: 'This video did not play',
  decoderStopped: 'The decoder stopped.',
  readFailed: (reason) => `Reading the file failed: ${reason}`,
  audioTrack: (number) => `Track ${number}`,
  subtitleTrack: (number) => `Subtitles ${number}`,
  codecUnsupported: (codec) => `${codec}, not supported yet`,
  timedText: 'Timed text',
  mono: 'mono',
  stereo: 'stereo',
  channels: (count) => `${count} ch`,
}

export function resolveMessages(overrides?: Partial<DecoderMessages>): DecoderMessages {
  return overrides ? { ...defaultMessages, ...overrides } : defaultMessages
}
