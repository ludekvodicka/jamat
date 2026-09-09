import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionModelInfo } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { AgentSettingsValue } from '../../shared/agentSettings'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import type { SessionModelHeld } from '../sessionModel/sessionModelStore'
import { ContextCompactionPanelModel } from './contextCompactionPanelModel'

describe('app-client-ui/renderer/contextCompaction/contextCompactionPanelModel', () => {
  const nowConst = 1_700_000_000_000
  const defaultsConst: AgentSettingsValue = {
    claude: { yolo: false },
    codex: { yolo: false },
  }

  function sessionOf(overrides: Partial<SessionInfo> = {}): SessionInfo {
    const source = SessionsFixtures.mixed().sessions
      .find((session) => session.sessionId === 's-working')
    if (source === undefined) throw new Error('The fixture has no working agent session')
    return { ...source, ...overrides }
  }

  function readingOf(
    overrides: Partial<SessionModelInfo> = {},
    readAt = nowConst,
  ): SessionModelHeld {
    return {
      info: {
        model: 'claude-sonnet-4-5-20260101',
        modelLabel: 'Sonnet 4.5',
        effortLevel: 'high',
        contextTokens: 150_000,
        contextWindow: 200_000,
        ...overrides,
      },
      readAt,
    }
  }

  it('shows the exact usage and provider auto-compact setting at the default threshold', () => {
    expect(ContextCompactionPanelModel.of(
      sessionOf(),
      readingOf(),
      defaultsConst,
      nowConst,
    )).toEqual({
      agentId: 'claude',
      agentLabel: 'Claude',
      percent: 75,
      contextTokens: 150_000,
      contextWindow: 200_000,
      autoCompactPercent: 40,
      autoCompactEnabled: false,
      message: 'Context is at 75%: 150,000 of 200,000 tokens. Compact is recommended.',
    })
  })

  it('uses one provider setting for every model of that provider', () => {
    const settings: AgentSettingsValue = {
      claude: { yolo: false },
      codex: {
        yolo: false,
        contextPanelPercent: 60,
        autoCompactPercent: 70,
        autoCompactEnabled: true,
      },
    }
    const session = sessionOf({ agent: { agentId: 'codex' } })
    const reading = readingOf({ model: 'gpt-5.6-sol', modelLabel: 'GPT-5.6 Sol' })

    const panel = ContextCompactionPanelModel.of(session, reading, settings, nowConst)

    expect(panel?.agentLabel).toBe('Codex')
    expect(panel?.autoCompactPercent).toBe(70)
    expect(panel?.autoCompactEnabled).toBe(true)
  })

  it('stays hidden below the configured threshold and for an unknown window', () => {
    expect(ContextCompactionPanelModel.of(
      sessionOf(),
      readingOf({ contextTokens: 60_000 }),
      defaultsConst,
      nowConst,
    )).toBeNull()
    expect(ContextCompactionPanelModel.of(
      sessionOf(),
      readingOf({ contextWindow: null }),
      defaultsConst,
      nowConst,
    )).toBeNull()
  })

  it('stays hidden when the reading is stale or the session cannot accept work', () => {
    expect(ContextCompactionPanelModel.of(
      sessionOf(),
      readingOf({}, nowConst - 40_000),
      defaultsConst,
      nowConst,
    )).toBeNull()
    expect(ContextCompactionPanelModel.of(
      sessionOf({ life: 'ended' }),
      readingOf(),
      defaultsConst,
      nowConst,
    )).toBeNull()
    expect(ContextCompactionPanelModel.of(
      sessionOf({ kind: 'shell', agent: undefined, activity: null }),
      readingOf(),
      defaultsConst,
      nowConst,
    )).toBeNull()
  })

  it('waits until the session, reading and settings are all known', () => {
    expect(ContextCompactionPanelModel.of(null, readingOf(), defaultsConst, nowConst)).toBeNull()
    expect(ContextCompactionPanelModel.of(sessionOf(), null, defaultsConst, nowConst)).toBeNull()
    expect(ContextCompactionPanelModel.of(sessionOf(), readingOf(), null, nowConst)).toBeNull()
  })
})
