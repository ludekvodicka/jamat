import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionActivity,
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionModelInfo } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { AgentSettingsValue } from '../../shared/agentSettings'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { ContextCompactionController } from './contextCompactionController'

describe('app-client-ui/renderer/contextCompaction/contextCompactionController', () => {
  let session: SessionInfo
  let snapshot: SessionsSnapshot
  let listeners: Set<() => void>
  let settingsListeners: Set<() => void>
  let settings: AgentSettingsValue | null
  let model: SessionModelInfo | null
  let reads: string[]
  let automatic: string[]
  let attached: boolean
  let typing: Set<string>
  let reports: string[]
  let controller: ContextCompactionController
  let cooldown: ContextCompactionCooldown | null
  let quietAt: number
  let draftListeners: Set<() => void>

  beforeEach(() => {
    vi.useFakeTimers()
    const source = SessionsFixtures.mixed().sessions
      .find((candidate) => candidate.sessionId === 's-working')
    if (source === undefined) throw new Error('The fixture has no working session')
    session = source
    snapshot = { ...SessionsFixtures.mixed(), revision: 1, sessions: [session] }
    listeners = new Set()
    settingsListeners = new Set()
    settings = {
      claude: { yolo: false, autoCompactEnabled: true },
      codex: { yolo: false },
    }
    model = {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 180_000,
      contextWindow: 200_000,
    }
    reads = []
    automatic = []
    attached = true
    typing = new Set()
    reports = []
    cooldown = null
    quietAt = 0
    draftListeners = new Set()
    controller = new ContextCompactionController(
      {
        current: () => ({ snapshot, error: null }),
        subscribe: (onChanged) => {
          listeners.add(onChanged)
          return () => { listeners.delete(onChanged) }
        },
      },
      {
        readNow: (sessionId) => {
          reads.push(sessionId)
          return Promise.resolve(model)
        },
      },
      {
        current: () => ({ value: settings, error: null }),
        subscribe: (onChanged) => {
          settingsListeners.add(onChanged)
          return () => { settingsListeners.delete(onChanged) }
        },
      },
      {
        cooldown: () => Promise.resolve(cooldown),
        hasTarget: () => attached,
        automatic: (sessionId) => {
          automatic.push(sessionId)
          return Promise.resolve({ kind: 'sent' })
        },
      },
      {
        status: (sessionId) => ({ characters: typing.has(sessionId) ? 1 : 0, quietAt }),
        subscribe: (listener) => {
          draftListeners.add(listener)
          return () => { draftListeners.delete(listener) }
        },
      },
      (message) => reports.push(message),
    )
  })

  afterEach(() => vi.useRealTimers())

  function push(activity: SessionActivity | null, overrides: Partial<SessionInfo> = {}): void {
    session = { ...session, ...overrides, activity }
    snapshot = { ...snapshot, revision: snapshot.revision + 1, sessions: [session] }
    for (const listener of listeners) listener()
  }

  function pushSettings(value: AgentSettingsValue | null): void {
    settings = value
    for (const listener of settingsListeners) listener()
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  it('reads fresh context and compacts when work finishes above the threshold', async () => {
    controller.start()
    await settle()
    expect(reads).toEqual([])

    push('idle')
    await settle()

    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual(['s-working'])
    expect(reports).toEqual([])
  })

  it('compacts a session already sitting idle above the threshold when it starts', async () => {
    session = { ...session, activity: 'idle' }
    snapshot = { ...snapshot, sessions: [session] }

    controller.start()
    await settle()

    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual(['s-working'])
  })

  it('reads once per idle stretch and again after the session works', async () => {
    controller.start()
    push('idle')
    await settle()
    expect(reads).toEqual(['s-working'])

    push('idle')
    push('idle')
    await settle()
    expect(reads).toEqual(['s-working'])

    push('working')
    push('idle')
    await settle()
    expect(reads).toEqual(['s-working', 's-working'])
    expect(automatic).toEqual(['s-working', 's-working'])
  })

  it('evaluates the same idle session again when the thresholds change', async () => {
    settings = {
      claude: { yolo: false, autoCompactEnabled: true, autoCompactPercent: 95 },
      codex: { yolo: false },
    }
    controller.start()
    push('idle')
    await settle()
    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual([])

    pushSettings({
      claude: { yolo: false, autoCompactEnabled: true, autoCompactPercent: 40 },
      codex: { yolo: false },
    })
    await settle()

    expect(reads).toEqual(['s-working', 's-working'])
    expect(automatic).toEqual(['s-working'])
  })

  it('leaves a session with no terminal in this renderer unlatched', async () => {
    attached = false
    controller.start()
    push('idle')
    await settle()
    expect(reads).toEqual([])

    attached = true
    push('idle')
    await settle()

    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual(['s-working'])
  })

  it('refuses a session somebody is writing into, and takes it up once they stop', async () => {
    typing.add('s-working')
    controller.start()
    push('idle')
    await settle()
    expect(reads).toEqual([])
    expect(automatic).toEqual([])

    typing.delete('s-working')
    push('idle')
    await settle()

    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual(['s-working'])
  })

  it('drops a compact somebody started writing into during the read, and latches nothing', async () => {
    controller.start()
    push('idle')
    await Promise.resolve()
    typing.add('s-working')
    await settle()
    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual([])

    typing.delete('s-working')
    push('idle')
    await settle()

    expect(reads).toEqual(['s-working', 's-working'])
    expect(automatic).toEqual(['s-working'])
  })

  /**
   * The case the clock was added for: a session over its threshold whose person stopped typing, in a
   * window where the sessions document has nothing to publish and no setting is being changed.
   */
  it('asks again on its own five minutes later, with nothing else moving', async () => {
    session = { ...session, activity: 'idle' }
    snapshot = { ...snapshot, sessions: [session] }
    typing.add('s-working')
    controller.start()
    await settle()
    expect(reads).toEqual([])

    typing.delete('s-working')
    vi.advanceTimersByTime(5 * 60_000)
    await settle()

    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual(['s-working'])
  })

  it('stops asking when it is stopped', async () => {
    session = { ...session, activity: 'idle' }
    snapshot = { ...snapshot, sessions: [session] }
    typing.add('s-working')
    const stop = controller.start()
    await settle()

    stop()
    typing.delete('s-working')
    vi.advanceTimersByTime(30 * 60_000)
    await settle()

    expect(reads).toEqual([])
    expect(automatic).toEqual([])
    expect(draftListeners.size).toBe(0)
  })

  it('reports a cooldown and retries at its exact expiry without another session event', async () => {
    const now = Date.now()
    cooldown = { requestedAt: now - 563_000, expiresAt: now + 37_000 }
    controller.start()
    push('idle')
    await settle()
    expect(reads).toEqual([])
    expect(automatic).toEqual([])
    expect(await controller.inspect(session.sessionId)).toMatchObject({
      nextCheckAt: now + 37_000,
      cooldown,
    })
    await vi.advanceTimersByTimeAsync(36_999)
    expect(automatic).toEqual([])
    cooldown = null
    await vi.advanceTimersByTimeAsync(1)
    expect(automatic).toEqual(['s-working'])
  })

  it('wakes fifteen seconds after Enter instead of waiting for the five-minute fallback', async () => {
    controller.start()
    typing.add(session.sessionId)
    push('idle')
    await settle()
    expect((await controller.inspect(session.sessionId)).nextCheckAt).toBeNull()
    typing.delete(session.sessionId)
    quietAt = Date.now() + 15_000
    for (const listener of draftListeners) listener()
    await settle()
    expect(await controller.inspect(session.sessionId)).toMatchObject({ nextCheckAt: quietAt })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(automatic).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(automatic).toEqual(['s-working'])
  })

  it('does not claim or compact when the hint only inspects a working session', async () => {
    controller.start()
    expect(await controller.inspect(session.sessionId)).toMatchObject({
      reason: 'The agent is working. Waiting for it to become idle.',
      nextCheckAt: null,
    })
    expect(reads).toEqual([])
    expect(automatic).toEqual([])
  })

  it('reports missing context and retries it without requiring a new idle transition', async () => {
    model = null
    controller.start()
    push('idle')
    await settle()
    expect(await controller.inspect(session.sessionId)).toMatchObject({
      reason: 'Context usage could not be read. Automatic compact cannot decide yet.',
      nextCheckAt: Date.now() + 5 * 60_000,
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(reads).toEqual(['s-working', 's-working'])
    expect(automatic).toEqual([])
  })

  it('does not treat waiting, a disabled switch or a low context as grounds to compact', async () => {
    controller.start()
    push('waiting')
    await settle()
    expect(reads).toEqual([])

    pushSettings({ claude: { yolo: false }, codex: { yolo: false } })
    push('idle')
    await settle()
    expect(reads).toEqual([])

    model = { ...model!, contextTokens: 60_000 }
    pushSettings({
      claude: { yolo: false, autoCompactEnabled: true },
      codex: { yolo: false },
    })
    await settle()
    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual([])

    push('working')
    model = null
    push('idle')
    await settle()
    expect(reads).toEqual(['s-working', 's-working'])
    expect(automatic).toEqual([])
  })

  it('rechecks session and settings after the fresh read settles', async () => {
    const waiting: { resolve: ((value: SessionModelInfo | null) => void) | null } = {
      resolve: null,
    }
    controller = new ContextCompactionController(
      {
        current: () => ({ snapshot, error: null }),
        subscribe: (onChanged) => {
          listeners.add(onChanged)
          return () => { listeners.delete(onChanged) }
        },
      },
      { readNow: () => new Promise((done) => { waiting.resolve = done }) },
      {
        current: () => ({ value: settings, error: null }),
        subscribe: (onChanged) => {
          settingsListeners.add(onChanged)
          return () => { settingsListeners.delete(onChanged) }
        },
      },
      {
        cooldown: () => Promise.resolve(null),
        hasTarget: () => true,
        automatic: (sessionId) => {
          automatic.push(sessionId)
          return Promise.resolve({ kind: 'sent' })
        },
      },
      {
        status: (sessionId) => ({ characters: typing.has(sessionId) ? 1 : 0, quietAt: 0 }),
        subscribe: () => () => undefined,
      },
      (message) => reports.push(message),
    )
    controller.start()
    push('idle')
    await Promise.resolve()
    settings = { claude: { yolo: false }, codex: { yolo: false } }
    waiting.resolve?.(model)
    await settle()

    expect(automatic).toEqual([])
  })

  it('ignores shell sessions, ended ones and a reading with no context window', async () => {
    controller.start()
    push('idle', { kind: 'shell', agent: undefined, activity: null })
    await settle()
    expect(reads).toEqual([])

    push('idle', { kind: 'agent', agent: { agentId: 'claude' }, life: 'ended' })
    await settle()
    expect(reads).toEqual([])

    model = { ...model!, contextWindow: null }
    push('idle', { life: 'live' })
    await settle()
    expect(reads).toEqual(['s-working'])
    expect(automatic).toEqual([])
  })

  it('drops a fresh read that finishes after the controller stops', async () => {
    const waiting: { resolve: ((value: SessionModelInfo | null) => void) | null } = {
      resolve: null,
    }
    controller = new ContextCompactionController(
      {
        current: () => ({ snapshot, error: null }),
        subscribe: (onChanged) => {
          listeners.add(onChanged)
          return () => { listeners.delete(onChanged) }
        },
      },
      { readNow: () => new Promise((done) => { waiting.resolve = done }) },
      {
        current: () => ({ value: settings, error: null }),
        subscribe: (onChanged) => {
          settingsListeners.add(onChanged)
          return () => { settingsListeners.delete(onChanged) }
        },
      },
      {
        cooldown: () => Promise.resolve(null),
        hasTarget: () => true,
        automatic: (sessionId) => {
          automatic.push(sessionId)
          return Promise.resolve({ kind: 'sent' })
        },
      },
      {
        status: (sessionId) => ({ characters: typing.has(sessionId) ? 1 : 0, quietAt: 0 }),
        subscribe: () => () => undefined,
      },
      (message) => reports.push(message),
    )
    const stop = controller.start()
    push('idle')
    await Promise.resolve()
    stop()
    waiting.resolve?.(model)
    await settle()

    expect(automatic).toEqual([])
    expect(listeners.size).toBe(0)
    expect(settingsListeners.size).toBe(0)
  })
})
