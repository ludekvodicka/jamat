import { describe, expect, it } from 'vitest'

import { AgentComposerReader } from './agentComposerReader'
import { AgentWorkInspectorAntigravity } from './agentWorkInspectorAntigravity'
import { WorkFixtures } from './fixtures/workFixtures'

describe('lib-orchestrator/sessionManager/workState/agentWorkInspectorAntigravity', () => {
  const fixtures = WorkFixtures.of('antigravity')

  it('classifies every recorded Antigravity fixture as expected', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1)
    for (const fixture of fixtures) {
      expect(AgentWorkInspectorAntigravity.inspect(fixture.frame).hint, fixture.file)
        .toBe(fixture.expected.hint)
      if (fixture.expected.composer !== undefined) {
        const reading = AgentComposerReader.read('antigravity', fixture.frame)
        expect(reading.composer, fixture.file).toEqual(fixture.expected.composer)
        expect(reading.echoHead, fixture.file).toBe(fixture.expected.echoHead)
      }
      if (fixture.expected.content !== undefined)
        expect(AgentComposerReader.content('antigravity', WorkFixtures.viewportOf(fixture)), fixture.file)
          .toEqual(fixture.expected.content)
    }
  })

  it('returns unknown when neither spinner nor working composer footer is present', () => {
    const idleScreen = [
      '  Done.',
      '─'.repeat(80),
      '>',
      '─'.repeat(80),
      'auto · Gemini 4 Neon · high',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: idleScreen,
      wideScreenTail: idleScreen,
      screenStyled: true,
    })).toEqual({ hint: 'unknown', evidence: [] })
  })

  it('does not classify quoted esc to cancel prose without a closed composer box as working', () => {
    const prose = 'The footer says esc to cancel while running a command.'
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '⣾ Running command...',
      screenTail: prose,
      wideScreenTail: prose,
      screenStyled: true,
    })).toEqual({ hint: 'unknown', evidence: [] })
  })

  it('classifies command permission prompts as blocked even when cursor moves or options wrap', () => {
    const permission = fixtures.find((fixture) => fixture.file === 'antigravity-live-permission-prompt.json')!
    const movedCursor = permission.frame.screenTail
      .replace('> 1. Yes, run command', '  1. Yes, run command')
      .replace('  4. No, cancel', '> 4. No, cancel')
    expect(AgentWorkInspectorAntigravity.inspect({
      ...permission.frame,
      screenTail: movedCursor,
    }).hint).toBe('blocked')

    // Narrow wrap pushes `Run this command?` and option 1 above the 8-row shallow window; the footer
    // anchors the screen and the wide window carries the permission wording.
    const narrowShallow = [
      "  3. Yes, and always allow in this conversation for commands that start with 'pnpm exec'",
      '  4. No, cancel',
      '',
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
      'esc to cancel',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: narrowShallow,
      wideScreenTail: permission.frame.wideScreenTail,
      screenStyled: true,
    }).hint).toBe('blocked')
  })

  it('classifies the workspace trust dialog as blocked even when No, exit is selected', () => {
    const trust = fixtures.find((fixture) => fixture.file === 'antigravity-live-trust-dialog.json')!
    const movedCursor = trust.frame.screenTail
      .replace('> Yes, I trust this folder', '  Yes, I trust this folder')
      .replace('  No, exit', '> No, exit')
    const inspection = AgentWorkInspectorAntigravity.inspect({
      ...trust.frame,
      screenTail: movedCursor,
    })
    expect(inspection.hint).toBe('blocked')
    expect(inspection.evidence.map((item) => item.signal)).toContain('blockedPrompt')
  })

  it('classifies a generic navigation selection menu as waiting', () => {
    const menu = [
      'Choose an approach:',
      '> 1. Option A',
      '  2. Option B',
      '',
      '↑/↓ Navigate',
      'esc to cancel',
    ].join('\n')
    const inspection = AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: menu,
      wideScreenTail: menu,
      screenStyled: true,
    })
    expect(inspection.hint).toBe('waiting')
    expect(inspection.evidence.map((item) => item.signal)).toContain('menuFooter')
  })

  it('does not misclassify quoted permission prompts above a live composer or echoed numbered messages', () => {
    const idle = fixtures.find((fixture) => fixture.file === 'antigravity-live-idle.json')!
    const quotedAboveIdle = [
      '  Fixed detection for Run this command? and ↑/↓ Navigate · tab Amend.',
      idle.frame.screenTail,
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: 'Requesting permission for:\n> 1. Yes, run command\n↑/↓ Navigate',
      screenTail: quotedAboveIdle,
      wideScreenTail: quotedAboveIdle,
      screenStyled: true,
    }).hint).toBe('idle')

    const echoedNumbered = [
      '─'.repeat(60),
      '> 1. Yes, proceed with the refactor',
      '',
      '  Working on it.',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: echoedNumbered,
      wideScreenTail: echoedNumbered,
      screenStyled: true,
    })).toEqual({ hint: 'unknown', evidence: [] })
  })

  it('distinguishes statusLine inspections from rendered screen inspections', () => {
    const status = AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'working',
      toolConfirmationPending: false,
    })!
    const permission = fixtures.find((fixture) => fixture.file === 'antigravity-live-permission-prompt.json')!
    const screenBlocked = AgentWorkInspectorAntigravity.inspect(permission.frame)
    expect(AgentWorkInspectorAntigravity.isStatusLineInspection(status)).toBe(true)
    expect(AgentWorkInspectorAntigravity.isStatusLineInspection(screenBlocked)).toBe(false)
    expect(AgentWorkInspectorAntigravity.isStatusLineInspection({ hint: 'unknown', evidence: [] })).toBe(false)
  })

  it('classifies Antigravity statusLine hints and merges them with rendered screen priority', () => {
    const blocked = AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'working',
      toolConfirmationPending: true,
    })
    expect(blocked?.hint).toBe('blocked')
    expect(AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'reviewing',
      toolConfirmationPending: false,
    })?.hint).toBe('waiting')
    expect(AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'tool_use',
      toolConfirmationPending: false,
    })?.hint).toBe('working')
    const idle = AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'idle',
      toolConfirmationPending: false,
    })
    expect(idle?.hint).toBe('idle')
    expect(AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'initializing',
      toolConfirmationPending: false,
    })).toBeNull()

    const workingScreen = { hint: 'working' as const, evidence: [{ source: 'screen' as const, signal: 'spinnerAboveRule', match: '⣾ Running' }] }
    const backgroundScreen = { hint: 'background' as const, evidence: [{ source: 'screen' as const, signal: 'backgroundTasksFooter', match: '·1task(s)·/tasks' }] }
    const idleScreen = { hint: 'idle' as const, evidence: [{ source: 'screen' as const, signal: 'composerIdleFooter', match: '? for shortcuts' }] }
    const unknownScreen = { hint: 'unknown' as const, evidence: [] }
    const statusBackground = AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'idle',
      toolConfirmationPending: false,
      taskCount: 1,
    })
    expect(statusBackground?.hint).toBe('background')
    expect(AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'idle',
      toolConfirmationPending: false,
      runningSubagents: 2,
    })?.hint).toBe('background')
    expect(AgentWorkInspectorAntigravity.fromStatusLine({
      agentState: 'working',
      toolConfirmationPending: false,
      taskCount: 1,
    })?.hint).toBe('working')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(workingScreen, blocked)?.hint).toBe('blocked')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(workingScreen, idle)?.hint).toBe('working')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(backgroundScreen, idle)?.hint).toBe('background')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(backgroundScreen, blocked)?.hint).toBe('blocked')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(idleScreen, statusBackground)?.hint).toBe('background')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(unknownScreen, statusBackground)?.hint).toBe('background')
    expect(AgentWorkInspectorAntigravity.mergeStatusLine(unknownScreen, idle)?.hint).toBe('idle')
  })

  it('classifies Antigravity background tasks accurately and avoids prose collisions', () => {
    const background = fixtures.find((fixture) => fixture.file === 'antigravity-live-background-tasks.json')!
    const idle = fixtures.find((fixture) => fixture.file === 'antigravity-live-idle.json')!
    const rule = '─'.repeat(80)

    // Foreground working with a background task drawer still reads as foreground working.
    const workingWithDrawer = [
      '⣾  Running command...',
      rule,
      '>',
      rule,
      '  ● [10:08:11] pnpm test... running',
      rule,
      'esc to cancel                                  auto · Gemini 4 Neon · high · 1 task(s) · /tasks',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: workingWithDrawer,
      wideScreenTail: workingWithDrawer,
      screenStyled: true,
    }).hint).toBe('working')

    // Narrow footer that clips `· 1 task(s) · /tasks` still reads as background from the running drawer row.
    const clippedFooter = [
      rule,
      '>',
      rule,
      '  ● [10:08:11] pnpm test... running',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: clippedFooter,
      wideScreenTail: clippedFooter,
      screenStyled: true,
    }).hint).toBe('background')

    // Footer-only task counter without a drawer still reads as background.
    const footerOnly = [
      rule,
      '>',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon · high · 2 task(s) · /tasks',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: footerOnly,
      wideScreenTail: footerOnly,
      screenStyled: true,
    }).hint).toBe('background')

    // Quoted permission prompt above a background-task composer stays background (never blocked).
    const quotedAboveBackground = [
      '  Requesting permission for:\n  Run this command?\n  > 1. Yes, run command\n  ↑/↓ Navigate',
      background.frame.screenTail,
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: 'Run this command?\n> 1. Yes, run command\n↑/↓ Navigate',
      screenTail: quotedAboveBackground,
      wideScreenTail: quotedAboveBackground,
      screenStyled: true,
    }).hint).toBe('background')

    // Prose mentioning background task syntax above a normal idle composer stays idle.
    const quotedBackgroundAboveIdle = [
      '  ● [10:08:11] pnpm test... running',
      '  Footer showed auto · Gemini 4 Neon · high · 1 task(s) · /tasks',
      idle.frame.screenTail,
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: quotedBackgroundAboveIdle,
      wideScreenTail: quotedBackgroundAboveIdle,
      screenStyled: true,
    }).hint).toBe('idle')

    // Zero tasks or a finished drawer row does not read as background.
    const zeroTasks = [
      rule,
      '>',
      rule,
      '  ● [10:08:11] pnpm test... done',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon · high · 0 task(s) · /tasks',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: zeroTasks,
      wideScreenTail: zeroTasks,
      screenStyled: true,
    }).hint).toBe('idle')
  })

  it('classifies Antigravity running subagents accurately and avoids prose collisions', () => {
    const subagents = fixtures.find((fixture) => fixture.file === 'antigravity-live-background-subagents.json')!
    const idle = fixtures.find((fixture) => fixture.file === 'antigravity-live-idle.json')!
    const rule = '─'.repeat(80)

    const inspected = AgentWorkInspectorAntigravity.inspect(subagents.frame)
    expect(inspected.hint).toBe('background')
    expect(inspected.evidence.map((item) => item.signal)).toContain('backgroundSubagentsFooter')
    expect(inspected.evidence.map((item) => item.signal)).toContain('backgroundSubagentRow')

    // Foreground working with a subagent drawer still reads as foreground working.
    const workingWithSubagent = [
      '⣾  Running command...',
      rule,
      '>',
      rule,
      '  ● Agent(self: Group 3 Worker (U6-U9)) · Gemini 4 Neon  Generating · 9m15s',
      rule,
      'esc to cancel                                 auto · Gemini 4 Neon · high · 1 subagent(s)',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: workingWithSubagent,
      wideScreenTail: workingWithSubagent,
      screenStyled: true,
    }).hint).toBe('working')

    // Narrow footer that clips `· 1 subagent(s)` still reads as background from the subagent drawer row.
    const clippedFooter = [
      rule,
      '>',
      rule,
      '  ● Agent(self: Group 3 Worker (U6-U9)) · Gemini 4 Neon  Verification shows... · 12m20s',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: clippedFooter,
      wideScreenTail: clippedFooter,
      screenStyled: true,
    }).hint).toBe('background')

    // Narrow drawer row that truncates the role before `)` still reads as background.
    const truncatedRole = [
      rule,
      '>',
      rule,
      '  ● Agent(self: Group 3 Wor... · 9m15s',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: truncatedRole,
      wideScreenTail: truncatedRole,
      screenStyled: true,
    }).hint).toBe('background')

    // Footer-only subagent counter without a drawer still reads as background, including beside tasks.
    const footerOnly = [
      rule,
      '>',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon · high · 2 subagent(s)',
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: footerOnly,
      wideScreenTail: footerOnly,
      screenStyled: true,
    }).hint).toBe('background')

    const tasksAndSubagents = [
      rule,
      '>',
      rule,
      '? for shortcuts  auto · Gemini 4 Neon · high · 1 task(s) · /tasks · 1 subagent(s)',
    ].join('\n')
    const combined = AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: tasksAndSubagents,
      wideScreenTail: tasksAndSubagents,
      screenStyled: true,
    })
    expect(combined.hint).toBe('background')
    expect(combined.evidence.map((item) => item.signal)).toContain('backgroundTasksFooter')
    expect(combined.evidence.map((item) => item.signal)).toContain('backgroundSubagentsFooter')

    // Quoted permission prompt above a subagent composer stays background (never blocked).
    const quotedAboveSubagent = [
      '  Requesting permission for:\n  Run this command?\n  > 1. Yes, run command\n  ↑/↓ Navigate',
      subagents.frame.screenTail,
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: 'Run this command?\n> 1. Yes, run command\n↑/↓ Navigate',
      screenTail: quotedAboveSubagent,
      wideScreenTail: quotedAboveSubagent,
      screenStyled: true,
    }).hint).toBe('background')

    // Prose mentioning subagent syntax above a normal idle composer stays idle.
    const quotedSubagentAboveIdle = [
      '  ● Agent(self: Group 3 Worker (U6-U9)) · Gemini 4 Neon  Generating · 9m15s',
      '  Footer showed auto · Gemini 4 Neon · high · 1 subagent(s)',
      idle.frame.screenTail,
    ].join('\n')
    expect(AgentWorkInspectorAntigravity.inspect({
      rawTail: '',
      screenTail: quotedSubagentAboveIdle,
      wideScreenTail: quotedSubagentAboveIdle,
      screenStyled: true,
    }).hint).toBe('idle')

    // Zero subagents or a finished subagent drawer row does not read as background.
    for (const finishedRow of [
      '  ● Agent(self: Group 3 Worker) · Gemini 4 Neon  Done',
      '  ● Agent(self: Group 3 Worker) · Gemini 4 Neon  Completed · 9m15s',
      '  ✓ Agent(self: Group 3 Worker) · Gemini 4 Neon  Generating · 9m15s',
    ]) {
      const zeroSubagents = [
        rule,
        '>',
        rule,
        finishedRow,
        rule,
        '? for shortcuts  auto · Gemini 4 Neon · high · 0 subagent(s)',
      ].join('\n')
      expect(AgentWorkInspectorAntigravity.inspect({
        rawTail: '',
        screenTail: zeroSubagents,
        wideScreenTail: zeroSubagents,
        screenStyled: true,
      }).hint, finishedRow).toBe('idle')
    }
  })
})
