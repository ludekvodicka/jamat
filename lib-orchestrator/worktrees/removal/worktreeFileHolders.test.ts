import { describe, expect, it } from 'vitest'

import { WorktreeFileHolders } from './worktreeFileHolders'

describe('lib-orchestrator/worktrees/removal/worktreeFileHolders', () => {
  it('reads the error out of the CLIXML Windows PowerShell writes to a redirected stderr, never the header', () => {
    const progress = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>'
    const stderr = `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${progress}`
      + '<S S="Error">Add-Type : Cannot add type &quot;JamatFileHolders&quot;_x000D__x000A_</S><S S="Error">At line:3 char:1_x000D__x000A_</S></Objs>'
    expect(WorktreeFileHolders.errorOf(stderr)).toBe('Add-Type : Cannot add type "JamatFileHolders"')
    expect(WorktreeFileHolders.errorOf(`#< CLIXML\r\n<Objs Version="1.1.0.1">${progress}</Objs>`)).toBe('')
  })

  it('keeps the first line of plain stderr', () => {
    expect(WorktreeFileHolders.errorOf('first line\r\nsecond line')).toBe('first line')
  })
})
