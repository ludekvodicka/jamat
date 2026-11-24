import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AntigravityConfigHome } from './antigravityConfigHome'

describe('lib-orchestrator/shared/antigravityConfigHome', () => {
  const saved = process.env.JAMAT_V3_GEMINI_DIR
  const fixture = join('C:', 'tmp', 'isolated-gemini')

  beforeEach(() => {
    delete process.env.JAMAT_V3_GEMINI_DIR
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.JAMAT_V3_GEMINI_DIR
    else process.env.JAMAT_V3_GEMINI_DIR = saved
  })

  it('falls back to .gemini beside the user home', () => {
    expect(AntigravityConfigHome.resolve()).toBe(join(homedir(), '.gemini', 'antigravity-cli'))
    expect(AntigravityConfigHome.globalConfigDirectory()).toBe(join(homedir(), '.gemini', 'config'))
  })

  it('reads both directories under JAMAT_V3_GEMINI_DIR', () => {
    process.env.JAMAT_V3_GEMINI_DIR = fixture
    expect(AntigravityConfigHome.resolve()).toBe(join(fixture, 'antigravity-cli'))
    expect(AntigravityConfigHome.globalConfigDirectory()).toBe(join(fixture, 'config'))
    expect(AntigravityConfigHome.transcriptFile(undefined, 'abc'))
      .toBe(join(fixture, 'antigravity-cli', 'brain', 'abc', '.system_generated', 'logs', 'transcript.jsonl'))
  })

  it('lets an explicit home win over the environment', () => {
    process.env.JAMAT_V3_GEMINI_DIR = fixture
    const asked = join('C:', 'tmp', 'asked-for')
    expect(AntigravityConfigHome.resolve(asked)).toBe(asked)
    expect(AntigravityConfigHome.globalConfigDirectory(asked)).toBe(asked)
  })

  it('treats a blank value as no value', () => {
    process.env.JAMAT_V3_GEMINI_DIR = '   '
    expect(AntigravityConfigHome.resolve()).toBe(join(homedir(), '.gemini', 'antigravity-cli'))
  })
})
