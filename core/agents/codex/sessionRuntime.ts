import { closeSync, openSync, readSync, statSync } from 'fs'
import type { SessionModelInfo } from '../../types/session.js'

interface RuntimeSettings {
  model: string
  effortLevel: string | null
}

interface RuntimeState {
  currentSettings: RuntimeSettings | null
  complete: SessionModelInfo | null
}

interface RuntimeCache {
  offset: number
  mtimeMs: number
  ino: number
  birthtimeMs: number
  remainder: Buffer
  fingerprint: Buffer
  state: RuntimeState
}

interface RuntimeFileStat {
  size: number
  mtimeMs: number
  ino: number
  birthtimeMs: number
}

type JsonObject = Record<string, unknown>

export class SessionRuntime {
  private static readonly TAIL_READ_BYTES = 512 * 1024
  private static readonly FINGERPRINT_BYTES = 64
  private static readonly cache = new Map<string, RuntimeCache>()

  static read(sessionFile: string): SessionModelInfo | null {
    const stat = SessionRuntime.stat(sessionFile)
    if (!stat || stat.size === 0) {
      SessionRuntime.cache.delete(sessionFile)
      return null
    }

    let cached: RuntimeCache | null = SessionRuntime.cache.get(sessionFile) ?? null
    if (!cached || SessionRuntime.mustReset(cached, stat))
      cached = SessionRuntime.readCold(sessionFile, stat)
    else if (stat.size > cached.offset) {
      if (!SessionRuntime.fingerprintMatches(sessionFile, cached))
        cached = SessionRuntime.readCold(sessionFile, stat)
      else
        cached = SessionRuntime.readAppend(sessionFile, stat, cached)
    } else if (stat.mtimeMs !== cached.mtimeMs)
      cached = SessionRuntime.readCold(sessionFile, stat)

    if (!cached) {
      SessionRuntime.cache.delete(sessionFile)
      return null
    }
    SessionRuntime.cache.set(sessionFile, cached)
    return cached.state.complete ? { ...cached.state.complete } : null
  }

  static modelLabel(model: string): string {
    const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(model)
    if (!match) return model
    const suffix = match[2]
      ?.split('-')
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ')
    return `GPT-${match[1]}${suffix ? ` ${suffix}` : ''}`
  }

  private static mustReset(cached: RuntimeCache, stat: RuntimeFileStat): boolean {
    if (stat.size < cached.offset) return true
    if (cached.ino && stat.ino && cached.ino !== stat.ino) return true
    return cached.birthtimeMs > 0 && stat.birthtimeMs > 0 && cached.birthtimeMs !== stat.birthtimeMs
  }

  private static readCold(sessionFile: string, stat: RuntimeFileStat): RuntimeCache | null {
    const tailStart = Math.max(0, stat.size - SessionRuntime.TAIL_READ_BYTES)
    let state: RuntimeState = { currentSettings: null, complete: null }
    let bytes = SessionRuntime.readBytes(sessionFile, tailStart, stat.size - tailStart)
    if (!bytes) return null
    let remainder = SessionRuntime.consume(state, Buffer.alloc(0), bytes, tailStart > 0)

    if (!state.complete && tailStart > 0) {
      state = { currentSettings: null, complete: null }
      bytes = SessionRuntime.readBytes(sessionFile, 0, stat.size)
      if (!bytes) return null
      remainder = SessionRuntime.consume(state, Buffer.alloc(0), bytes, false)
    }

    const fingerprint = SessionRuntime.readFingerprint(sessionFile, stat.size)
    if (!fingerprint) return null
    return {
      offset: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      birthtimeMs: stat.birthtimeMs,
      remainder,
      fingerprint,
      state,
    }
  }

  private static readAppend(sessionFile: string, stat: RuntimeFileStat, cached: RuntimeCache): RuntimeCache | null {
    const bytes = SessionRuntime.readBytes(sessionFile, cached.offset, stat.size - cached.offset)
    if (!bytes) return null
    cached.remainder = SessionRuntime.consume(cached.state, cached.remainder, bytes, false)
    cached.offset = stat.size
    cached.mtimeMs = stat.mtimeMs
    cached.ino = stat.ino
    cached.birthtimeMs = stat.birthtimeMs
    const fingerprint = SessionRuntime.readFingerprint(sessionFile, stat.size)
    if (!fingerprint) return null
    cached.fingerprint = fingerprint
    return cached
  }

  private static consume(state: RuntimeState, remainder: Buffer, bytes: Buffer, dropFirstPartial: boolean): Buffer {
    let data = remainder.length > 0 ? Buffer.concat([remainder, bytes]) : bytes
    if (dropFirstPartial) {
      const firstNewline = data.indexOf(0x0a)
      if (firstNewline < 0) return Buffer.alloc(0)
      data = data.subarray(firstNewline + 1)
    }
    const lastNewline = data.lastIndexOf(0x0a)
    if (lastNewline < 0) return Buffer.from(data)
    const complete = data.subarray(0, lastNewline).toString('utf-8')
    for (const line of complete.split('\n'))
      if (line.trim()) SessionRuntime.consumeLine(state, line)
    return Buffer.from(data.subarray(lastNewline + 1))
  }

  private static consumeLine(state: RuntimeState, line: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { return }
    const record = SessionRuntime.object(parsed)
    if (!record) return
    const payload = SessionRuntime.object(record.payload)
    if (!payload) return

    if (record.type === 'turn_context') {
      const model = SessionRuntime.nonEmptyString(payload.model)
      if (!model) return
      state.currentSettings = { model, effortLevel: SessionRuntime.effort(payload) }
      return
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count' || !state.currentSettings) return

    const info = SessionRuntime.object(payload.info)
    const lastUsage = SessionRuntime.object(info?.last_token_usage)
    const contextTokens = SessionRuntime.nonNegativeInteger(lastUsage?.total_tokens)
    const contextWindow = SessionRuntime.positiveInteger(info?.model_context_window)
    if (contextTokens === null || contextWindow === null) return
    state.complete = {
      model: state.currentSettings.model,
      modelLabel: SessionRuntime.modelLabel(state.currentSettings.model),
      contextTokens,
      contextWindow,
      effortLevel: state.currentSettings.effortLevel,
    }
  }

  private static effort(payload: JsonObject): string | null {
    const collaborationMode = SessionRuntime.object(payload.collaboration_mode)
    const settings = SessionRuntime.object(collaborationMode?.settings)
    for (const value of [payload.effort, payload.reasoning_effort, settings?.reasoning_effort]) {
      const effort = SessionRuntime.nonEmptyString(value)
      if (effort) return effort
    }
    return null
  }

  private static object(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null
  }

  private static nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  private static nonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  private static positiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  }

  private static stat(sessionFile: string): RuntimeFileStat | null {
    try {
      const stat = statSync(sessionFile)
      if (!stat.isFile()) return null
      return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
    } catch {
      return null
    }
  }

  private static fingerprintMatches(sessionFile: string, cached: RuntimeCache): boolean {
    const current = SessionRuntime.readFingerprint(sessionFile, cached.offset)
    return !!current && current.equals(cached.fingerprint)
  }

  private static readFingerprint(sessionFile: string, offset: number): Buffer | null {
    const length = Math.min(SessionRuntime.FINGERPRINT_BYTES, offset)
    return SessionRuntime.readBytes(sessionFile, offset - length, length)
  }

  private static readBytes(sessionFile: string, offset: number, length: number): Buffer | null {
    if (length === 0) return Buffer.alloc(0)
    let fd: number
    try { fd = openSync(sessionFile, 'r') } catch { return null }
    try {
      const buffer = Buffer.alloc(length)
      let total = 0
      while (total < length) {
        const read = readSync(fd, buffer, total, length - total, offset + total)
        if (read === 0) break
        total += read
      }
      return total === length ? buffer : null
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }
}
