// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

import type { SourceAdapter } from 'movi-player'
import type { ByteSource } from './byte-source.js'

export interface ByteSourceAdapterOptions {
  /** Stable id for the player's caches, for example the stream key. */
  key: string
  /** Attempts per read before the failure goes to the player. */
  attempts?: number
  /** First retry delay; doubles each time. */
  retryDelayMs?: number
  /** Failures that will never succeed (the file was deleted); these stop playback at once. */
  isPermanent?: (error: unknown) => boolean
  /** Told about each failed attempt that will be retried, for logging. */
  onRetry?: (error: unknown, attempt: number) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Feeds movi-player's FFmpeg demuxer from any {@link ByteSource}, with retries, so the decoder
 * reads straight from your storage (through a `ChunkedSource` cache, for example)
 * without a Service Worker or a URL in between.
 *
 * FFmpeg's reader takes short reads in its stride but reads an empty answer as the end of the
 * file, so an empty read before the end is retried here as a failure rather than passed on.
 */
export class ByteSourceAdapter implements SourceAdapter {
  private readonly source: ByteSource
  private readonly key: string
  private readonly attempts: number
  private readonly retryDelayMs: number
  private readonly isPermanent: (error: unknown) => boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onRetry: (error: unknown, attempt: number) => void

  private position = 0
  private closed = false
  private fatal: Error | null = null
  private refusing = false
  private last: Error | null = null

  constructor(source: ByteSource, options: ByteSourceAdapterOptions) {
    this.source = source
    this.key = options.key
    this.attempts = Math.max(1, options.attempts ?? 4)
    this.retryDelayMs = options.retryDelayMs ?? 400
    this.isPermanent = options.isPermanent ?? (() => false)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.onRetry = options.onRetry ?? (() => undefined)
  }

  /** The most recent read failure, cleared by the next successful read. */
  get lastError(): Error | null {
    return this.last
  }

  getSize(): Promise<number> {
    return Promise.resolve(this.source.size)
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    if (this.closed) throw new Error('The source is closed')
    if (this.fatal) throw this.fatal

    const start = Math.max(0, Math.min(offset, this.source.size))
    const wanted = Math.max(0, Math.min(length, this.source.size - start))
    if (wanted === 0) return new ArrayBuffer(0)

    let lastError: unknown = null
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) {
        this.refusing = true
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1))
        if (this.closed) throw new Error('The source is closed')
      }
      try {
        const bytes = await this.source.read(start, wanted)
        if (bytes.byteLength === 0) throw new Error(`Empty read at ${start} of ${this.source.size}`)
        this.refusing = false
        this.last = null
        this.position = start + bytes.byteLength
        return copyToBuffer(bytes)
      } catch (error) {
        lastError = error
        this.last = error instanceof Error ? error : new Error(String(error))
        if (this.isPermanent(error)) {
          this.fatal = error instanceof Error ? error : new Error(String(error))
          this.refusing = false
          throw this.fatal
        }
        if (attempt + 1 < this.attempts) this.onRetry(error, attempt + 1)
      }
    }
    this.refusing = false
    throw lastError instanceof Error ? lastError : new Error('Read failed')
  }

  seek(offset: number): number {
    this.position = Math.max(0, Math.min(offset, this.source.size))
    return this.position
  }

  getPosition(): number {
    return this.position
  }

  close(): void {
    this.closed = true
  }

  getKey(): string {
    return this.key
  }

  getFatalError(): Error | null {
    return this.fatal
  }

  isRefusing(): boolean {
    return this.refusing
  }
}

/** An ArrayBuffer holding exactly these bytes, so the player never sees the cache's buffers. */
function copyToBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}
