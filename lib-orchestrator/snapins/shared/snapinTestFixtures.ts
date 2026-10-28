import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { SessionInfo, SessionsSnapshot } from '../../sessionManager/sessionManagerApi.types'
import { SnapinsManager } from '../snapinsManager'
import type { SnapinPresentationPort, SnapinsSettings, SnapinSessionsPort } from '../snapinsApi.types'
import { PassInbox } from './passInbox'
import type { AttemptRecord, SnapinContext, SnapinDefinition, SnapinItem } from './snapinContract'
import type { SnapinStore } from './snapinStore'

export class SnapinTestRig {
  root: string
  directory: string
  now: number
  snapshot: SessionsSnapshot
  definitions: SnapinDefinition[]
  items: Map<string, SnapinItem[]>
  settings: SnapinsSettings
  sessions: SnapinSessionsPort
  presentation: SnapinPresentationPort
  manager: SnapinsManager
  changed: Mock<(kind: string) => void>
  report: Mock<(message: string) => void>

  private constructor(root: string, kinds: string[]) {
    this.root = root
    this.directory = join(root, 'orchestrator', 'fixture', 'development', 'snapins')
    this.now = 1_000_000
    this.items = new Map(kinds.map((kind) => [kind, []]))
    this.settings = { limit: 4, agents: ['claude'], workerPrompts: { claude: 'Work {pass}' }, kinds: {} }
    this.snapshot = { revision: 0, reconciled: true, sessions: [], categories: [], orphans: [],
      host: { presence: 'running', hostVersion: null, hostInstanceId: null, liveCount: 0, lastStartError: null } }
    this.sessions = { snapshot: () => this.snapshot, versioningMode: () => 'checkpoints',
      openTerminal: vi.fn(async () => 'ok' as const),
      createSession: vi.fn(async (_spec, origin) => {
        const sessionId = randomUUID()
        this.snapshot.sessions.push(SnapinTestRig.session(sessionId, origin.callerOperationId))
        return { ok: true as const, value: { sessionId, tabTitle: 'Worker' } }
      }), worktreeResults: vi.fn(async () => ({ ok: true as const, value: { results: [] } })),
      acknowledgeWorktreeResult: vi.fn(async (actionId) => ({ ok: true as const, value: { actionId } })) }
    this.presentation = { ensureGroups: vi.fn(async () => true), assign: vi.fn(() => 'ok' as const), setNote: vi.fn(async () => 'ok' as const) }
    this.definitions = kinds.map((kind) => ({ kind, title: kind, colour: 'cyan', menuOrder: 1,
      settings: { fields: async () => [], validate: () => null },
      list: vi.fn(async () => ({ ok: true as const, items: this.items.get(kind)! })),
      launchSpec: vi.fn(async (_ctx, _values, item, attemptId) => ({ directory: { mode: 'adHoc' as const, path: item.projectDirectory },
        title: item.title, number: item.key, worktreeSlug: attemptId.slice(0, 8), work: { kind: 'fixture' } })),
      evidence: vi.fn(async () => ({ published: false as const })), solveAllOrder: (items) => items,
      press: async () => ({ ok: false as const, code: 'unknown-action' as const }),
    }))
    this.changed = vi.fn()
    this.report = vi.fn()
    this.manager = this.newManager()
  }

  static async create(kinds = ['test']): Promise<SnapinTestRig> {
    const root = await mkdtemp(join(tmpdir(), 'snapin-flow-'))
    vi.stubEnv('JAMAT_V3_LOCAL_STATE_DIR', root)
    return new SnapinTestRig(root, kinds)
  }

  newManager(): SnapinsManager {
    return new SnapinsManager({ definitions: this.definitions, directory: this.directory, now: () => this.now,
      settings: () => this.settings, presentation: this.presentation, onChanged: this.changed, report: this.report,
      ports: { sessions: this.sessions, svn: { urlOf: async () => ({ ok: true, value: '' }),
        listAtHead: async () => ({ ok: true, value: [] }), changedNames: async () => ({ ok: true, value: [] }) },
        projects: { projects: async () => [] } } })
  }

  store(kind = 'test'): SnapinStore { return this.manager['kinds'].get(kind)!.store }
  context(): SnapinContext { return this.manager['context'](this.manager['kinds'].values().next().value!) }
  async tick(): Promise<void> {
    this.manager.wake()
    while (this.manager['ticking']) await this.manager['ticking']
  }
  /** What the shown panel does: a tick lists a source only when asked. */
  async list(kind = 'test') { return this.press('refresh', [], kind) }
  async press(action: string, keys: string[] = [], kind = 'test') {
    const answer = await this.manager.press(kind, `shared.${action}`, keys)
    while (this.manager['ticking']) await this.manager['ticking']
    return answer
  }
  async item(key: string, mode: 'wc' | 'wt' = 'wc', kind = 'test', directory = join(this.root, key)): Promise<SnapinItem> {
    await mkdir(directory, { recursive: true })
    const item: SnapinItem = { key, mode, title: key, group: 'Project', projectDirectory: directory, selectable: true, actions: [], payload: {} }
    this.items.get(kind)!.push(item)
    return item
  }
  async attempt(overrides: Partial<AttemptRecord> = {}, kind = 'test'): Promise<AttemptRecord> {
    const record: AttemptRecord = { attemptId: randomUUID(), itemKey: 'one', title: 'One', group: 'Project',
      mode: 'wc', projectDirectory: this.root, agentId: 'claude', phase: 'working', createdAt: this.now,
      appliedThrough: 0, leaseHeld: true, ...overrides }
    await PassInbox.create(this.pass(record, kind), { schema: 1, attemptId: record.attemptId, kind, mode: record.mode,
      projectDirectory: record.projectDirectory, priorAttemptId: null, work: { kind: 'fixture' } })
    await this.store(kind).update((doc) => { doc.attempts.push(record); return doc })
    return record
  }
  pass(attempt: AttemptRecord, kind = 'test'): string { return join(this.directory, kind, 'passes', attempt.attemptId) }
  static session(sessionId: string, callerOperationId?: string, life: SessionInfo['life'] = 'live'): SessionInfo {
    return { sessionId, callerOperationId, life, kind: 'agent', title: 'Worker', tabTitle: 'Worker',
      directory: { mode: 'adHoc', path: 'Q:/unused' } } as SessionInfo
  }
  async close(): Promise<void> { await this.manager.stop(); vi.unstubAllEnvs(); await rm(this.root, { recursive: true, force: true }) }
}
