import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClipboardAccess } from './clipboardAccess'

/** A clipboard another process can be holding: the write lands only once `held` runs out. */
const clipboardMock = vi.hoisted(() => ({
  content: '',
  writes: 0,
  held: 0,
}))

vi.mock('electron', () => ({
  clipboard: {
    writeText: (text: string) => {
      clipboardMock.writes++
      if (clipboardMock.held > 0) {
        clipboardMock.held--
        return
      }
      clipboardMock.content = text
    },
    readText: () => clipboardMock.content,
  },
}))

describe('app-client-ui/app/shared/clipboardAccess', () => {
  beforeEach(() => {
    clipboardMock.content = ''
    clipboardMock.writes = 0
    clipboardMock.held = 0
  })

  it('reads what the clipboard holds', () => {
    clipboardMock.content = 'from somewhere else'
    expect(ClipboardAccess.readText()).toBe('from somewhere else')
  })

  it('writes once when nothing is holding the clipboard', async () => {
    expect(await ClipboardAccess.writeText('landed')).toBe(true)
    expect(clipboardMock.content).toBe('landed')
    expect(clipboardMock.writes).toBe(1)
  })

  // The whole reason this class exists: Chromium's write is silent about a clipboard it could not
  // take, so a single attempt is a copy the user believes in and does not have.
  it('repeats a write another process swallowed, until it sticks', async () => {
    clipboardMock.held = 3
    expect(await ClipboardAccess.writeText('landed late')).toBe(true)
    expect(clipboardMock.content).toBe('landed late')
    expect(clipboardMock.writes).toBe(4)
  })

  it('gives up and says so rather than claiming a copy that never happened', async () => {
    clipboardMock.held = Number.MAX_SAFE_INTEGER
    expect(await ClipboardAccess.writeText('never lands')).toBe(false)
    expect(clipboardMock.content).toBe('')
  })
})
