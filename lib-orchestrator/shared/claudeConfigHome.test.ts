import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClaudeConfigHome } from './claudeConfigHome'

describe('lib-orchestrator/shared/claudeConfigHome', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('falls back to .claude beside the user home', () => {
    expect(ClaudeConfigHome.resolve()).toBe(join(homedir(), '.claude'))
  })

  it('reads CLAUDE_CONFIG_DIR, which is what Claude Code itself honours', () => {
    process.env.CLAUDE_CONFIG_DIR = join('C:', 'tmp', 'isolated-profile')
    expect(ClaudeConfigHome.resolve()).toBe(join('C:', 'tmp', 'isolated-profile'))
  })

  it('lets an explicit home win over the environment', () => {
    process.env.CLAUDE_CONFIG_DIR = join('C:', 'tmp', 'isolated-profile')
    const asked = join('C:', 'tmp', 'asked-for')
    expect(ClaudeConfigHome.resolve(asked)).toBe(asked)
  })

  it('treats a blank value as no value', () => {
    process.env.CLAUDE_CONFIG_DIR = '   '
    expect(ClaudeConfigHome.resolve()).toBe(join(homedir(), '.claude'))
  })

  // An explicit blank is a caller that asked for nothing, not a caller that asked for the
  // environment: it was handed in on purpose and the fallback is the default home.
  it('does not let a blank explicit home fall through to the environment', () => {
    process.env.CLAUDE_CONFIG_DIR = join('C:', 'tmp', 'isolated-profile')
    expect(ClaudeConfigHome.resolve('  ')).toBe(join(homedir(), '.claude'))
  })
})
