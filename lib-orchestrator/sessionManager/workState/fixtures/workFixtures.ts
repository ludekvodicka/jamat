import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentWorkFrame, AgentWorkHint } from '../agentWorkInspector.types'
import type { SessionRecordAgent } from '../../records/sessionRecord.types'

export interface WorkFixtureProvenance {
  /** The corpus this frame came from, named so a reader can go and look at it. */
  origin: string
  case: string
  /** How the screen came to exist: captured from a live TUI, or written as a collision negative. */
  capture: string
  ported: string
  identical: string
  note?: string
}

/**
 * Present on a frame taken off this tree's own live Host by `scripts/dev/capture-workstate.ts`.
 * The build matters as much as the screen: two sessions of the same reported version draw the
 * selection marker differently, because a running agent keeps the binary it started with. A fixture
 * is therefore evidence about a build, not about "Claude", and a frame that will not say which one
 * is not evidence at all.
 */
export interface WorkFixtureRecording {
  build: string
  capturedAt: string
}

export interface WorkFixture {
  file: string
  agent: SessionRecordAgent['agentId']
  expected: { hint: AgentWorkHint }
  provenance: WorkFixtureProvenance
  recorded?: WorkFixtureRecording
  frame: AgentWorkFrame
}

/**
 * The recorded screens beside this file. Each one states where it came from, and a fixture that does
 * not is refused here rather than quietly becoming a screen nobody can vouch for.
 */
export class WorkFixtures {
  static of(agent: SessionRecordAgent['agentId']): WorkFixture[] {
    return WorkFixtures.all().filter((fixture) => fixture.agent === agent)
  }

  static all(): WorkFixture[] {
    return readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => WorkFixtures.read(name))
  }

  private static read(name: string): WorkFixture {
    const parsed = JSON.parse(
      readFileSync(join(import.meta.dirname, name), 'utf8'),
    ) as Omit<WorkFixture, 'file'>
    const provenance = parsed.provenance
    if (!provenance?.origin || !provenance.case || !provenance.capture)
      throw new Error(`Work fixture ${name} does not say where its screen came from`)
    const recorded = parsed.recorded
    if (recorded !== undefined && (!recorded.build || !recorded.capturedAt))
      throw new Error(`Work fixture ${name} claims a recording without saying which build or when`)
    return { file: name, ...parsed }
  }
}
