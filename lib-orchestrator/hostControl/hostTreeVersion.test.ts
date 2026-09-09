import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostTreeVersion } from './hostTreeVersion'

describe('lib-orchestrator/hostControl/hostTreeVersion', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** A tree with an `app-host` in it, and a package.json only when this test wants one. */
  function tree(version?: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-host-tree-version-'))
    roots.push(root)
    mkdirSync(join(root, 'app-host'), { recursive: true })
    if (version !== undefined)
      writeFileSync(join(root, 'app-host', 'package.json'), JSON.stringify({ version }), 'utf8')
    return root
  }

  it('reads the version a Host started from this tree would report', () => {
    expect(new HostTreeVersion(tree('2026.08.10.1')).current()).toBe('2026.08.10.1')
  })

  /*
   * Three ways to have no answer, and all of them are null rather than a guess: a null can never be
   * read as a match, so the surface says `unknown` instead of telling somebody their Host is current.
   */
  it('answers null for a missing file, an unreadable one and a version that is not a string', () => {
    expect(new HostTreeVersion(tree()).current()).toBeNull()

    const damaged = tree()
    writeFileSync(join(damaged, 'app-host', 'package.json'), '{ half a package', 'utf8')
    expect(new HostTreeVersion(damaged).current()).toBeNull()

    expect(new HostTreeVersion(tree(3)).current()).toBeNull()
  })

  it('holds its answer for half a minute and then reads again', () => {
    vi.useFakeTimers()
    const root = tree('1.0.0')
    const version = new HostTreeVersion(root)
    expect(version.current()).toBe('1.0.0')

    writeFileSync(
      join(root, 'app-host', 'package.json'),
      JSON.stringify({ version: '2.0.0' }),
      'utf8',
    )
    expect(version.current()).toBe('1.0.0')

    vi.setSystemTime(Date.now() + 31_000)
    expect(version.current()).toBe('2.0.0')
  })
})
