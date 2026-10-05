import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentWorkFrame, AgentWorkHint, ComposerViewport } from '../agentWorkInspector.types'
import { ScreenTail } from '../screenTail'
import type { SessionRecordAgent } from '../../records/sessionRecord.types'
import type { TerminalComposerContent, TerminalComposerReading } from '../../sessionManagerApi.types'

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
  /** The terminal width the screen was laid out in, which the row join of a draft depends on. */
  cols?: number
  /** The terminal height, where the frame proves it; the height Claude's box stops growing at. */
  rows?: number
}

/**
 * The viewport of an inspect with no scrollback, recorded beside the frame for
 * `AgentComposerReader.content`. The recording Hosts predate styled `screenLines`, so this keeps the
 * serialized bytes, which carry the dim style and are rebuilt into rows by
 * `ScreenTail.viewportOfScreen`. Recorded only at a width the terminal never shrank to: after a
 * shrink the bytes keep cells beyond the new width.
 */
export interface WorkFixtureViewport {
  screen: string
  rows: number
}

export interface WorkFixture {
  file: string
  agent: SessionRecordAgent['agentId']
  expected: {
    hint: AgentWorkHint
    /**
     * Present on the frames recorded for `AgentComposerReader`, all four together. A frame without
     * them is still classified by the inspector tests and skipped by the reader's.
     */
    composer?: TerminalComposerReading['composer']
    queuedRow?: boolean
    echoHead?: string | null
    pastePlaceholders?: number
    /** Present on the frames recorded for `AgentComposerReader.content`, with `recorded.cols`. */
    content?: TerminalComposerContent
  }
  provenance: WorkFixtureProvenance
  recorded?: WorkFixtureRecording
  frame: AgentWorkFrame
  viewport?: WorkFixtureViewport
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

  /**
   * The viewport `AgentComposerReader.content` reads. A frame recorded before the viewport was lends
   * its wide window: its row 0 is then the window's top, which is at or below the viewport's, and
   * a height the frame does not prove is the window's own, so both can only make a reading more
   * cautious than the live one.
   */
  static viewportOf(fixture: WorkFixture): ComposerViewport {
    const cols = fixture.recorded?.cols
    if (cols === undefined) throw new Error(`Work fixture ${fixture.file} does not say how wide it was`)
    if (fixture.viewport !== undefined)
      return ScreenTail.viewportOfScreen({ screen: fixture.viewport.screen, cols, rows: fixture.viewport.rows })
    const rows = fixture.frame.wideScreenTail.split('\n')
    return { rows, cols, height: fixture.recorded?.rows ?? rows.length }
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
    if ((parsed.viewport !== undefined || parsed.expected.content !== undefined) && recorded?.cols === undefined)
      throw new Error(`Work fixture ${name} carries a viewport reading without a recorded width`)
    return { file: name, ...parsed }
  }
}
