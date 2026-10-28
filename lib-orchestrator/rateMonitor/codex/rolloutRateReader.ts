import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountView } from '../../agentAccounts/agentAccountsApi.types'
import { JsonShape } from '../../shared/jsonShape'
import type { RateExternalReading } from '../rateMonitor'
import type { RateWindow } from '../rateMonitorApi.types'
import { CodexRateLimitMapping } from './codexRateLimitMapping'

interface RolloutSample { at: number; windows: readonly RateWindow[] }
interface Cursor {
  offset: number; mtime: number; identity: string; carry: Buffer; creator: string | null
  samples: RolloutSample[]; discarding: boolean
}

export class RolloutRateReader {
  private readonly home: string
  private readonly accounts: () => Promise<readonly AccountView[]>
  private readonly cursors = new Map<string, Cursor>()
  private identities = ''

  constructor(home: string, accounts: () => Promise<readonly AccountView[]>) {
    this.home = home
    this.accounts = accounts
  }

  async read(): Promise<readonly RateExternalReading[]> {
    const accounts = (await this.accounts()).filter(account => account.agentId === 'codex' && account.identity !== null)
    const identities = JSON.stringify(accounts.map(account => [account.accountId, account.identity!.key]))
    const remap = identities !== this.identities
    const byIdentity = new Map(accounts.map(account => [account.identity!.key, account.accountId]))
    const readings: RateExternalReading[] = []
    const files = await this.files(join(this.home, 'sessions'))
    const next = new Map<string, Cursor>()
    const cutoff = Date.now() - 90 * 24 * 60 * 60_000
    for (const file of files) {
      const metadata = await stat(file)
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
    return readings.sort((a, b) => a.at - b.at)
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
