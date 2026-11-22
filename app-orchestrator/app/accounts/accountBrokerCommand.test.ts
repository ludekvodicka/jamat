import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountBrokerCommand } from './accountBrokerCommand'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AccountBrokerCommand', () => {
  it('quotes the wrapper path with forward slashes, then names the instance and both placeholders', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat broker home-'))
    roots.push(root)
    const skills = join(root, 'User Name', '.claude', 'skills')
    mkdirSync(join(skills, 'appjamat-v3', 'scripts'), { recursive: true })
    writeFileSync(join(skills, 'appjamat-v3', 'scripts', 'jamat-v3.mjs'), '')
    const wrapper = `${root.split(sep).join('/')}/User Name/.claude/skills/appjamat-v3/scripts/jamat-v3.mjs`
    expect(wrapper).not.toContain(String.fromCharCode(92))
    expect(AccountBrokerCommand.of(skills, 'b5c1d2e3-0000-4000-8000-000000000001', 'development')).toBe(
      `node "${wrapper}" --config-identity b5c1d2e3-0000-4000-8000-000000000001 --channel development accounts pick --caller {caller} --purpose {purpose}`)
    expect(AccountBrokerCommand.report(skills, 'b5c1d2e3-0000-4000-8000-000000000001', 'development', { caller: 'indexer', purpose: 'background' }, 'work-1a2b'))
      .toBe(`node "${wrapper}" --config-identity b5c1d2e3-0000-4000-8000-000000000001 --channel development accounts report --caller indexer --purpose background --account work-1a2b`)
  })

  it('answers null when the wrapper file does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-broker-missing-'))
    roots.push(root)
    expect(AccountBrokerCommand.of(join(root, '.claude', 'skills'), 'id', 'production')).toBeNull()
    expect(AccountBrokerCommand.report(join(root, '.claude', 'skills'), 'id', 'production', { caller: 'x', purpose: 'interactive' }, 'main')).toBeNull()
  })
})
