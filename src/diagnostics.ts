// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Roshan-Here (https://github.com/Roshan-Here) - Web-Buildin-decoder

/**
 * A short log of what the decoder did, for working out why a video did not play. Entries are
 * kept in memory so an error panel can offer to copy them. Warnings and errors also go to the
 * console with a `[decoder]` prefix; the everyday steps ("loading", "opened") only when asked
 * for, with `configureDiagnostics({ verbose: true })` or `localStorage.debug = 'decoder'`
 * (or `'*'`) in the console.
 */
export interface DiagnosticEntry {
  at: string
  event: string
  detail?: unknown
}

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticsOptions {
  /** Log everyday steps to the console as well. Default: from `localStorage.debug`. */
  verbose?: boolean
  /** Entries kept in memory. Default 200. */
  limit?: number
  /**
   * Receives every entry, for your own logging or error reporting. When set, the console is
   * left alone.
   */
  sink?: (level: DiagnosticLevel, event: string, detail: unknown) => void
}

let settings: DiagnosticsOptions = {}
const entries: DiagnosticEntry[] = []

export function configureDiagnostics(options: DiagnosticsOptions): void {
  settings = { ...settings, ...options }
}

/** Records one step. Used by the decoder; available to your own code around it. */
export function logDecoder(event: string, detail?: unknown, level: DiagnosticLevel = 'info'): void {
  const entry: DiagnosticEntry = {
    at: new Date().toISOString(),
    event,
    detail: serialisable(detail),
  }
  entries.push(entry)
  const limit = Math.max(1, settings.limit ?? 200)
  while (entries.length > limit) entries.shift()
  if (settings.sink) {
    settings.sink(level, event, entry.detail)
    return
  }
  if (level === 'info' && !verbose()) return
  const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug
  if (detail === undefined) log('[decoder]', event)
  else log('[decoder]', event, detail)
}

/** The entries kept so far, oldest first. */
export function diagnosticEntries(): readonly DiagnosticEntry[] {
  return entries.slice()
}

export function clearDiagnostics(): void {
  entries.length = 0
}

/** Everything a bug report needs, as text: your context, the browser and the log. */
export function diagnosticsReport(context: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      context,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      webCodecs: typeof VideoDecoder !== 'undefined',
      crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
      entries,
    },
    null,
    2,
  )
}

function verbose(): boolean {
  if (settings.verbose !== undefined) return settings.verbose
  try {
    const debug = globalThis.localStorage?.getItem('debug') ?? ''
    return debug === '*' || debug.split(',').includes('decoder')
  } catch {
    return false
  }
}

/** Errors (and error-like objects with a code and text) as plain data that JSON can hold. */
function serialisable(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (value && typeof value === 'object' && 'text' in value && 'code' in value) {
    const coded = value as { code: unknown; text: unknown }
    return { code: coded.code, text: coded.text }
  }
  return value
}
