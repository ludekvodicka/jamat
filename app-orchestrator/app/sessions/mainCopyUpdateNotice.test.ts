import { describe, expect, it } from 'vitest'

import { MainCopyUpdateNotice } from './mainCopyUpdateNotice'

describe('app-client-ui/app/sessions/mainCopyUpdateNotice', () => {
  const update = { sessionId: 's1', title: '001 - J01 W1', mainCopy: 'Q:/Work/App', revision: 1481, by: 'person' as const, log: 'Q:/results/a1/run.log' }

  it('names the session, the main copy and its revision, and offers the kept UPDATE log', () => {
    expect(MainCopyUpdateNotice.of(update)).toEqual({
      sessionId: 's1',
      title: 'Main copy updated: 001 - J01 W1',
      body: 'Q:/Work/App is at r1481. Click to open the update log, kept with the worktree result.',
      log: 'Q:/results/a1/run.log',
    })
  })

  it('says who asked when an agent did, and where the result is when no log could be kept', () => {
    expect(MainCopyUpdateNotice.of({ ...update, by: 'agent', log: null })).toEqual({
      sessionId: 's1',
      title: 'Main copy updated: 001 - J01 W1',
      body: 'Q:/Work/App is at r1481, updated by an agent. No update log could be kept; sessions worktree-results has the result.',
      log: null,
    })
  })
})
