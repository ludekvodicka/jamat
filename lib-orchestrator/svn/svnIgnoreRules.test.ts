import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SvnIgnoreRules } from './svnIgnoreRules'
import { SvnProps } from './svnProps'

const props = (text: string) => SvnProps.parseSkel(new TextEncoder().encode(text))

describe('SvnIgnoreRules', () => {
  it('matches like APR fnmatch: case-sensitive sets, stars across dots, ranges and negation', () => {
    expect(SvnIgnoreRules.matches('[Tt]humbs.db', 'Thumbs.db')).toBe(true)
    expect(SvnIgnoreRules.matches('[Tt]humbs.db', 'thumbs.db')).toBe(true)
    expect(SvnIgnoreRules.matches('[Tt]humbs.db', 'THUMBS.DB')).toBe(false)
    expect(SvnIgnoreRules.matches('*.swp', '.a.swp')).toBe(true)
    expect(SvnIgnoreRules.matches('*.so.[0-9]*', 'lib.so.3')).toBe(true)
    expect(SvnIgnoreRules.matches('[!a]?', 'bc')).toBe(true)
    expect(SvnIgnoreRules.matches('[!a]?', 'ac')).toBe(false)
    expect(SvnIgnoreRules.matches('#*#', '#x#')).toBe(true)
    expect(SvnIgnoreRules.matches('node_modules', 'node_modules2')).toBe(false)
  })

  it('reads [miscellany] global-ignores with continuation lines, and falls back to the built-in list without the key', async () => {
    expect(SvnIgnoreRules.globalIgnoresOf('[auth]\nglobal-ignores = no\n[miscellany]\n# global-ignores = commented\nglobal-ignores = *.o .checkpoints\n  node_modules\nenable-auto-props = yes\n'))
      .toBe('*.o .checkpoints node_modules')
    expect(SvnIgnoreRules.globalIgnoresOf('[miscellany]\n# global-ignores = *.o\n')).toBeNull()
    const appData = await mkdtemp(join(tmpdir(), 'svn-config-'))
    try {
      await mkdir(join(appData, 'Subversion'))
      await writeFile(join(appData, 'Subversion', 'config'), '[miscellany]\n### global-ignores = x\n')
      const fallback = SvnIgnoreRules.fromRuntimeConfig(appData)
      expect(fallback.ignored('Thumbs.db', SvnProps.emptyConst, [])).toBe(true)
      expect(fallback.ignored('.checkpoints', SvnProps.emptyConst, [])).toBe(false)
      expect(SvnIgnoreRules.fromRuntimeConfig(appData)).toBe(fallback)
      await writeFile(join(appData, 'Subversion', 'config'), '[miscellany]\nglobal-ignores = .checkpoints\n')
      const set = SvnIgnoreRules.fromRuntimeConfig(appData)
      expect(set.ignored('.checkpoints', SvnProps.emptyConst, [])).toBe(true)
      expect(set.ignored('Thumbs.db', SvnProps.emptyConst, [])).toBe(false)
    } finally { await rm(appData, { recursive: true, force: true }) }
  })

  it('applies svn:ignore of the parent by line and global ignores of the ancestors', () => {
    const rules = new SvnIgnoreRules([])
    const parent = props('(svn:ignore 19 node_modules\n*.log\n)')
    expect(rules.ignored('node_modules', parent, [])).toBe(true)
    expect(rules.ignored('a.log', parent, [])).toBe(true)
    expect(rules.ignored('a.ts', parent, [])).toBe(false)
    expect(rules.ignored('x.wav', SvnProps.emptyConst, ['*.wav'])).toBe(true)
  })
})
