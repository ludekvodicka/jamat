import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import {
  type SessionDetailsBaseline,
  type SessionDetailsDraft,
  SessionDetailsModel,
} from './sessionDetailsModel'

/** A live numbered Codex session in a project, which each test then narrows. */
function infoOf(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's-1',
    kind: 'agent',
    title: '014 - Alpha',
    titleParts: { number: '014', name: 'Alpha' },
    tabTitle: 'AppJamatV3 - 014 - Alpha',
    directory: {
      mode: 'project',
      categoryId: 'nodejs',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    },
    project: {
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    },
    agent: { agentId: 'codex', nativeSessionId: 'native-1' },
    life: 'live',
    activity: 'idle',
    admits: [],
    ...over,
  }
}

function baselineOf(over: Partial<SessionInfo> = {}): SessionDetailsBaseline {
  return SessionDetailsModel.baselineOf(infoOf(over))
}

/** The draft exactly as the card opens it: the baseline's own values, nothing touched yet. */
function draftOf(
  baseline: SessionDetailsBaseline,
  over: Partial<SessionDetailsDraft> = {},
): SessionDetailsDraft {
  return { name: baseline.name, note: baseline.note, color: baseline.color, ...over }
}

describe('app-client-ui/renderer/overlays/sessionDetails/sessionDetailsModel', () => {
  it('captures the chip, the editable fields and the read-only block', () => {
    expect(baselineOf({ note: 'the point of it', color: 'teal' })).toEqual({
      sessionId: 's-1',
      numberChip: '014',
      name: 'Alpha',
      note: 'the point of it',
      color: 'teal',
      agentId: 'codex',
      life: 'live',
      displaySessionId: 'native-1',
      projectLabel: 'AppJamatV3',
      folderPath: 'C:/Projects/NodeJs/AppJamatV3',
      agentLabel: 'Codex',
    })
  })

  it('falls back to the record id and reads an ad-hoc binding as its path', () => {
    const baseline = baselineOf({
      title: 'Scratch',
      titleParts: { number: null, name: 'Scratch' },
      directory: { mode: 'adHoc', path: 'Q:/Scratch' },
      project: { kind: 'adHoc', path: 'Q:/Scratch' },
      agent: undefined,
      kind: 'shell',
      activity: null,
    })
    expect(baseline.numberChip).toBeNull()
    expect(baseline.displaySessionId).toBe('s-1')
    expect(baseline.projectLabel).toBe('Q:/Scratch')
    expect(baseline.folderPath).toBe('Q:/Scratch')
    expect(baseline.agentLabel).toBe('Shell')
  })

  // The session runs in its worktree, so that is the folder the row has to name.
  it('names the worktree as the folder where one exists, and none for the default directory', () => {
    expect(baselineOf({
      worktree: {
        worktreePath: 'C:/Projects/NodeJs/AppJamatV3/.worktrees/alpha',
        branch: 'feature/alpha',
        baseCommit: 'aa11bb22',
        diff: null,
        baseMoved: false,
      },
    }).folderPath).toBe('C:/Projects/NodeJs/AppJamatV3/.worktrees/alpha')
    expect(baselineOf({
      directory: { mode: 'default' },
      project: { kind: 'none' },
    })).toMatchObject({ folderPath: null, projectLabel: 'None' })
  })

  it('answers null for a draft that changed nothing, trimming before it compares', () => {
    const baseline = baselineOf({ note: 'kept' })
    expect(SessionDetailsModel.updateOf(baseline, draftOf(baseline))).toBeNull()
    expect(SessionDetailsModel.updateOf(baseline, draftOf(baseline, {
      name: '  Alpha  ',
      note: 'kept ',
    }))).toBeNull()
  })

  // The update is a diff: only the fields that moved travel, so a name-only save cannot revert a
  // colour another surface wrote while the card was open. An empty note still clears with null.
  it('carries only the fields that changed', () => {
    const baseline = baselineOf({ note: 'old', color: 'red' })
    expect(SessionDetailsModel.updateOf(baseline, draftOf(baseline, { name: 'Renamed' })))
      .toEqual({ name: 'Renamed' })
    expect(SessionDetailsModel.updateOf(baseline, draftOf(baseline, { note: '', color: null })))
      .toEqual({ note: null, color: null })
    expect(SessionDetailsModel.updateOf(baseline, draftOf(baseline, { note: 'new words' })))
      .toEqual({ note: 'new words' })
  })

  /*
   * Whether the agent has to be told, and what to tell it, left this model on 2026-08-24: it is a
   * question about the record, and the record is the library's. What the card decides is what to do
   * with the answer, which `sessionDetailsOverlay.test.tsx` holds, and the case itself moved to
   * `sessionLifecycle.test.ts`.
   */
})
