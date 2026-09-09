import { describe, expect, it } from 'vitest'

import { LateBoundCommand } from './lateBoundCommand'

describe('app-client-ui/renderer/shell/lateBoundCommand', () => {
  it('runs what was bound, with the argument it was opened with', () => {
    const opened: (string | null)[] = []
    const command = new LateBoundCommand<string | null>('settings')

    command.bind((tab) => opened.push(tab))
    command.open('window')
    command.open(null)

    expect(opened).toEqual(['window', null])
  })

  // The command is registered at composition and bound on every render, so an accelerator can
  // arrive before the first binding commits. Saying nothing would look like a key that does not
  // work; the wiring mistake has to name itself.
  it('names itself when it runs before the shell bound it', () => {
    const command = new LateBoundCommand('launcher')

    expect(() => command.open()).toThrow(
      'The launcher command ran before the shell bound it')
  })

  it('runs the LAST binding, because a re-render binds again', () => {
    const opened: string[] = []
    const command = new LateBoundCommand<string>('session details')

    command.bind(() => opened.push('first'))
    command.bind(() => opened.push('second'))
    command.open('s-1')

    expect(opened).toEqual(['second'])
  })
})
