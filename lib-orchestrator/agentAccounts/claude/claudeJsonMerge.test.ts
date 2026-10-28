import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeClaudeJson } from './claudeJsonMerge'

describe('Claude profile settings merge', () => {
  it('merges only listed keys, preserves private keys and leaves damaged or linked account files untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-claude-merge-'))
    const home = join(root, 'account')
    mkdirSync(home)
    const main = join(root, 'main.json')
    const account = join(home, '.claude.json')
    const source = { hasCompletedOnboarding: true, mcpServers: { user: {} },
      projects: { '/work': { hasTrustDialogAccepted: true, allowedTools: ['Read'], privateMain: true } },
      oauthAccount: { mainOnly: true } }
    writeFileSync(main, JSON.stringify(source))
    writeFileSync(account, JSON.stringify({ private: 42, oauthAccount: { accountOnly: true },
      projects: { '/work': { privateProject: true, hasTrustDialogAccepted: false }, '/other': { keep: true } } }))
    try {
      mergeClaudeJson(home, main)
      expect(JSON.parse(readFileSync(account, 'utf8'))).toEqual({ private: 42, oauthAccount: { accountOnly: true },
        hasCompletedOnboarding: true, mcpServers: { user: {} },
        projects: { '/work': { privateProject: true, hasTrustDialogAccepted: true, allowedTools: ['Read'] }, '/other': { keep: true } } })
      writeFileSync(account, '{broken')
      expect(() => mergeClaudeJson(home, main)).toThrow('could not be read')
      expect(readFileSync(account, 'utf8')).toBe('{broken')
      unlinkSync(account)
      symlinkSync(main, account, 'file')
      expect(() => mergeClaudeJson(home, main)).toThrow('must not be a link')
      unlinkSync(account)
      expect(JSON.parse(readFileSync(main, 'utf8'))).toEqual(source)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
