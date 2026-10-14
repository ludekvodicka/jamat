import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClipboardPastePaths } from './clipboardPastePaths'

describe('app-client-ui/app/shared/clipboardPastePaths', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jamat-v3-paste-paths-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reads every line as a file when every line is one, quoted or not', () => {
    const first = join(directory, 'a.png')
    const second = join(directory, 'b c.txt')
    writeFileSync(first, 'a')
    writeFileSync(second, 'b')
    expect(ClipboardPastePaths.filesOf(`"${first}"\r\n\r\n  ${second}  \n`)).toEqual([first, second])
  })

  it('keeps a text a text when one line is not an existing file', () => {
    const file = join(directory, 'a.png')
    writeFileSync(file, 'a')
    const folder = join(directory, 'folder')
    mkdirSync(folder)
    expect(ClipboardPastePaths.filesOf(`${file}\n${join(directory, 'missing.png')}`)).toBeNull()
    expect(ClipboardPastePaths.filesOf(folder)).toBeNull()
    expect(ClipboardPastePaths.filesOf('a.png')).toBeNull()
    expect(ClipboardPastePaths.filesOf('   ')).toBeNull()
  })

  it('quotes a path with a space and leaves any other as it is', () => {
    expect(ClipboardPastePaths.textOf('C:/a/b.png')).toBe('C:/a/b.png')
    expect(ClipboardPastePaths.textOf('C:/my files/b.png')).toBe('"C:/my files/b.png"')
  })
})
