import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountView } from '../../agentAccounts/agentAccountsApi.types'
import { ErrnoCode } from '../../shared/errnoCode'
import { JsonShape } from '../../shared/jsonShape'
import type { RateExternalReading } from '../rateMonitor'
import type { RateWindow } from '../rateMonitorApi.types'
import { CodexRateLimitMapping } from './codexRateLimitMapping'

interface RolloutSample { at: number; windows: readonly RateWindow[] }
interface Cursor {
  offset: number; mtime: number; identity: string; carry: Buffer; creator: string | null
  samples: RolloutSample[]; discarding: boolean
}

/**
 * Rate windows out of the Codex rollout files. The feed asks every five seconds, and the history under
 * `sessions/` grows by hundreds of files: a pass lists only the date directories of today and
 * yesterday plus the known files written within the last hour, and the whole tree is walked at most
 * once per ten minutes. That walk is what still finds an old conversation resumed into its own file.
 */
export class RolloutRateReader {
  private static readonly walkMillisecondsConst = 600_000
  private static readonly openMillisecondsConst = 3_600_000
  private readonly home: string
  private readonly accounts: () => Promise<readonly AccountView[]>
  private readonly now: () => number
  private readonly cursors = new Map<string, Cursor>()
  private identities = ''
  private walkedAt = -Infinity

  constructor(home: string, accounts: () => Promise<readonly AccountView[]>, now: () => number = Date.now) {
    this.home = home
    this.accounts = accounts
    this.now = now
  }

  async read(): Promise<readonly RateExternalReading[]> {
    const accounts = (await this.accounts()).filter(account => account.agentId === 'codex' && account.identity !== null)
    const identities = JSON.stringify(accounts.map(account => [account.accountId, account.identity!.key]))
    const remap = identities !== this.identities
    const byIdentity = new Map(accounts.map(account => [account.identity!.key, account.accountId]))
    const readings: RateExternalReading[] = []
    const now = this.now()
    // A remap replays every cursor's samples, so it needs every file, not only the recent ones.
    const walk = remap || now - this.walkedAt >= RolloutRateReader.walkMillisecondsConst
    const sessions = join(this.home, 'sessions')
    const files = walk ? await this.files(sessions) : await this.recentFiles(sessions, now)
    const next = new Map<string, Cursor>(walk ? [] : this.cursors)
    const cutoff = now - 90 * 24 * 60 * 60_000
    for (const file of files) {
      let metadata
      try { metadata = await stat(file) }
      catch (error) {
        if (ErrnoCode.of(error) !== 'ENOENT') throw error
        next.delete(file)
        continue
      }
      const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
      let cursor = this.cursors.get(file)
      if (!cursor || cursor.identity !== identity || metadata.size < cursor.offset || metadata.mtimeMs < cursor.mtime)
        cursor = { offset: 0, mtime: 0, identity, carry: Buffer.alloc(0), creator: null, samples: [], discarding: false }
      else cursor = { ...cursor, samples: [...cursor.samples] }
      const previousLength = cursor.samples.length
      await this.append(file, cursor, metadata.size)
      cursor.mtime = metadata.mtimeMs
      next.set(file, cursor)
      const accountId = cursor.creator === null ? 'main' : byIdentity.get(cursor.creator)
      if (accountId !== undefined)
        for (const sample of cursor.samples.slice(remap ? 0 : previousLength))
          if (sample.at >= cutoff) readings.push({ key: { agentId: 'codex', accountId }, ...sample, source: 'rollout', backfill: true })
      cursor.samples = cursor.samples.filter(sample => sample.at >= cutoff)
    }
    this.cursors.clear()
    for (const [file, cursor] of next) this.cursors.set(file, cursor)
    this.identities = identities
    if (walk) this.walkedAt = now
    return readings.sort((a, b) => a.at - b.at)
  }

  private async recentFiles(sessions: string, now: number): Promise<string[]> {
    const files = new Set<string>()
    for (const [file, cursor] of this.cursors)
      if (now - cursor.mtime < RolloutRateReader.openMillisecondsConst) files.add(file)
    for (const directory of RolloutRateReader.dateDirectories(sessions, now))
      for (const file of await this.files(directory)) files.add(file)
    return [...files]
  }

  /** Codex names the directory by the local date; the UTC one is added for a clock either side of midnight. */
  private static dateDirectories(sessions: string, now: number): string[] {
    const pad = (value: number) => String(value).padStart(2, '0')
    const directories = new Set<string>()
    for (const at of [now, now - 86_400_000]) {
      const date = new Date(at)
      directories.add(join(sessions, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())))
      directories.add(join(sessions, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())))
    }
    return [...directories]
  }

  private async append(path: string, cursor: Cursor, end: number): Promise<void> {
    if (cursor.offset === end) return
    const file = await open(path, 'r')
    const chunk = Buffer.alloc(256 * 1024)
    try {
      while (cursor.offset < end) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, end - cursor.offset), cursor.offset)
        if (bytesRead === 0) break
        const data = Buffer.concat([cursor.carry, chunk.subarray(0, bytesRead)])
        let start = 0
        for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
          const bytes = data.subarray(start, newline)
          start = newline + 1
          if (cursor.discarding) { cursor.discarding = false; continue }
          if (bytes.length > 1_048_576) continue
          const line = bytes.toString('utf8')
          let row: Record<string, unknown> | null
          try { row = JsonShape.record(JSON.parse(line)) } catch { continue }
          const payload = JsonShape.record(row?.payload)
          if (!row || !payload) continue
          if (row.type === 'session_meta')
            cursor.creator = typeof payload.creator_account_id === 'string' ? payload.creator_account_id : null
          if (row.type !== 'event_msg' || payload.type !== 'token_count') continue
          const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
          const windows = RolloutRateReader.windowsOf(payload.rate_limits)
          if (Number.isFinite(at) && windows.length > 0) cursor.samples.push({ at, windows })
        }
        cursor.carry = Buffer.from(data.subarray(start))
        if (cursor.carry.length > 1_048_576 || cursor.discarding) {
          cursor.carry = Buffer.alloc(0)
          cursor.discarding = true
        }
        cursor.offset += bytesRead
      }
    } finally { await file.close() }
  }

  private async files(directory: string): Promise<string[]> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const files: string[] = []
    for (const entry of entries)
      if (entry.isDirectory()) files.push(...await this.files(join(directory, entry.name)))
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(join(directory, entry.name))
    return files
  }

  static windowsOf(value: unknown): readonly RateWindow[] {
    const limits = JsonShape.record(value)
    if (!limits || (limits.limit_id !== undefined && limits.limit_id !== 'codex')) return []
    const mapped: Record<string, unknown> = {}
    for (const key of ['primary', 'secondary']) {
      const window = JsonShape.record(limits[key])
      if (window) mapped[key] = { usedPercent: window.used_percent, windowDurationMins: window.window_minutes, resetsAt: window.resets_at }
    }
    return CodexRateLimitMapping.windowsOf({ rateLimits: mapped })
  }
}
