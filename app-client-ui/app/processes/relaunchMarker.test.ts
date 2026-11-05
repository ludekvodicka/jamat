import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelaunchMarker } from './relaunchMarker'

describe('RelaunchMarker', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-relaunch-'))
    directories.push(directory)
    const file = join(directory, 'child-relaunch.json')
    return { file, marker: new RelaunchMarker(file) }
  }

  it('persists the first crash, refuses 30 seconds and permits 90 seconds', () => {
    const { file, marker } = fixture(), at = 100_000
    expect(marker.canRelaunch(at)).toBe(true)
    marker.record(at)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at })
    const next = new RelaunchMarker(file)
    expect(next.canRelaunch(at + 30_000)).toBe(false)
    expect(next.canRelaunch(at + 90_000)).toBe(true)
    expect(next.canRelaunch(at + 60_000)).toBe(true)
  })

  it('refuses a future timestamp and fails closed on unreadable or malformed state', () => {
    const { file, marker } = fixture()
    marker.record(100_000)
    expect(marker.canRelaunch(90_000)).toBe(false)
    writeFileSync(file, '{"at":"invalid"}')
    expect(() => marker.canRelaunch(110_000)).toThrow('Invalid child relaunch marker')
    writeFileSync(file, '{broken')
    expect(() => marker.canRelaunch(110_000)).toThrow()
    rmSync(file)
    mkdirSync(file)
    expect(() => marker.canRelaunch(110_000)).toThrow()
  })
})
