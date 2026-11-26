import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ShellPathNames } from './shellPathNames'

describe.skipIf(process.platform !== 'win32')('lib-orchestrator/sessionUncommitted/claims/shellPathNames', () => {
  const bases = ['Q:/Project/app', 'Q:/Project']
  const names = (command: string) => ShellPathNames.of(command, bases).map((path) => path.replace(/\\/g, '/'))

  it('reads absolute names in both slash forms and Git Bash names', () => {
    expect(names('sed -i s/a/b/ Q:\\Project\\src\\a.ts')).toContain('Q:/Project/src/a.ts')
    expect(names('cat "Q:/Project/src/b.ts"')).toEqual(['Q:/Project/src/b.ts'])
    expect(names('cd /q/Project && rm /q/Project/old.txt')).toEqual(['Q:/Project', 'Q:/Project/old.txt'])
  })

  it('resolves a relative name against every base', () => {
    expect(names('sed -i s/x/y/ app/a.ts')).toEqual([
      'Q:/Project/app/s/x/y', 'Q:/Project/s/x/y', 'Q:/Project/app/app/a.ts', 'Q:/Project/app/a.ts',
    ])
    expect(names("Set-Content b.ts 'x'")).toEqual(['Q:/Project/app/b.ts', 'Q:/Project/b.ts'])
    expect(names("python -c \"edit('src/c.ts', [])\"")).toEqual(['Q:/Project/app/src/c.ts', 'Q:/Project/src/c.ts'])
  })

  it('skips words, flags, URLs, variables and foreign absolute paths', () => {
    expect(names('pnpm test --filter=x -v https://example.com/a.ts $HOME/a.ts /etc/hosts')).toEqual([])
  })

  it('reads at most 64 path tokens of one command', () => {
    const command = Array.from({ length: 100 }, (_, index) => `Q:/Project/f${index}.ts`).join(' ')
    const found = ShellPathNames.of(command, bases)
    expect(found).toHaveLength(ShellPathNames.maxTokensConst)
    expect(found.at(-1)).toBe(resolve('Q:/Project/f63.ts'))
  })
})
