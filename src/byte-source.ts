// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * Anything the decoder can read byte ranges from: a remote file, a `File` from an
 * `<input type="file">`, a cloud object, a peer-to-peer stream. Implement this to feed the
 * decoder from your own storage.
 */
export interface ByteSource {
  readonly size: number
  /**
   * Reads up to `length` bytes starting at `offset`. May return fewer bytes than asked (the
   * decoder then asks for the rest), but at least one unless `offset` is at the end.
   */
  read(offset: number, length: number): Promise<Uint8Array>
  /**
   * A second reader over the same file for occasional reads away from the playhead (timeline
   * previews), which must not disturb playback: it shares what is already downloaded but
   * neither moves the read ahead nor pushes playback's chunks out of the cache.
   */
  createSideReader?(): ByteSource
}
