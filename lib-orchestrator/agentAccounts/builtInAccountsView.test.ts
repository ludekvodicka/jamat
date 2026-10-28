import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { builtInAccountProfiles } from './builtInAccountsView'
import { AgentAccounts } from './agentAccounts'
import { CommandInvoker } from '../shared/commandInvoker'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home }))

describe('built-in identity metadata', () => {
  it('reads default main metadata beside .claude and explicit/added metadata inside their homes without invoking a command', async () => {
    fixture.home = mkdtempSync(join(tmpdir(), 'jamat-identity-'))
    const invoke = vi.spyOn(CommandInvoker.prototype, 'run').mockRejectedValue(new Error('No command may run'))
    const metadata = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'org', extra: 'private' } })
    try {
      mkdirSync(join(fixture.home, '.claude'))
      writeFileSync(join(fixture.home, '.claude.json'), metadata('default@test'))
      writeFileSync(join(fixture.home, '.claude', '.claude.json'), metadata('wrong@test'))
      const defaults = builtInAccountProfiles({ CLAUDE_CONFIG_DIR: '' })
      expect(await defaults.specs[0]!.probe(defaults.mainHomes.claude)).toEqual({ kind: 'logged-in', identity: { key: 'org/default@test', label: 'default@test' } })
      const explicit = join(fixture.home, 'explicit')
      const added = join(fixture.home, 'added')
      mkdirSync(explicit)
      mkdirSync(added)
      writeFileSync(join(explicit, '.claude.json'), metadata('explicit@test'))
      writeFileSync(join(added, '.claude.json'), metadata('added@test'))
      const profiles = builtInAccountProfiles({ CLAUDE_CONFIG_DIR: explicit })
      expect(await profiles.specs[0]!.probe(added)).toEqual({ kind: 'logged-in', identity: { key: 'org/added@test', label: 'added@test' } })
      const accounts = new AgentAccounts({ ...profiles, accountsRoot: join(fixture.home, 'accounts'), stored: () => [], store: () => {}, hasRunningSession: () => false, onChanged: () => {} })
      expect((await accounts.list())[0]!.identity).toEqual({ key: 'org/explicit@test', label: 'explicit@test' })
      expect(invoke).not.toHaveBeenCalled()
    } finally { invoke.mockRestore(); rmSync(fixture.home, { recursive: true, force: true }) }
  })
})
