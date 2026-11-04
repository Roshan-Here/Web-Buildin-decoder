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
  /**
   * Where the bytes already downloaded from [offset] on run out: [offset] itself when that byte
   * is not here yet, the size when everything to the end is. For the loaded part of the
   * timeline; sources that cannot tell leave it out.
   */
  bufferedEnd?(offset: number): number
  /** Every stretch downloaded, as [start, end) byte ranges in order, for the timeline. */
  bufferedRuns?(): Array<[number, number]>
  /**
   * Told the video's length once it is known, so a source that reads ahead can size that by
   * time (see `ChunkedSource.fitReadAhead`). Sources that do not read ahead leave it out.
   */
  fitReadAhead?(durationSeconds: number): void
}
