import { describe, expect, it, vi } from 'vitest'

import type { CommandInvoker } from './commandInvoker'
import { TortoiseCommitDialog } from './tortoiseCommitDialog'
import { TortoiseConflictEditor } from './tortoiseConflictEditor'

describe('lib-orchestrator/shared/tortoiseConflictEditor', () => {
  it('launches the conflict editor of TortoiseSVN on the absolute path, from the folder that holds it', async () => {
    const closed = Promise.resolve()
    const launchInteractive = vi.fn<CommandInvoker['launchInteractive']>(async () => ({ ok: true, closed }))
    const editor = new TortoiseConflictEditor({ platform: 'win32', exists: () => true, commands: { launchInteractive } })

    expect(await editor.open('Q:\\Work\\App\\.worktrees\\006 incident\\.aidocs\\engines')).toEqual({ ok: true, closed })
    expect(launchInteractive).toHaveBeenCalledExactlyOnceWith({
      command: TortoiseCommitDialog.svnToolConst,
      cwd: 'Q:\\Work\\App\\.worktrees\\006 incident\\.aidocs',
      env: expect.any(Object),
      args: ['/command:conflicteditor', '/path:Q:\\Work\\App\\.worktrees\\006 incident\\.aidocs\\engines'],
    })
  })

  it.each(['linux', 'missing'] as const)('refuses on %s with the path of the tool it expected, without a launch', async (state) => {
    const launchInteractive = vi.fn()
    const editor = new TortoiseConflictEditor({ platform: state === 'linux' ? 'linux' : 'win32', exists: () => false, commands: { launchInteractive } })
    expect(await editor.open('Q:\\Work\\App\\src\\catalog.ts'))
      .toEqual({ ok: false, detail: `TortoiseSVN's conflict editor is unavailable: ${TortoiseCommitDialog.svnToolConst}` })
    expect(launchInteractive).not.toHaveBeenCalled()
  })
})
