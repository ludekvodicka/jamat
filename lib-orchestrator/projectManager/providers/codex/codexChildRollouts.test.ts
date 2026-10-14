import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexChildFixtures } from '../../../sessionTasks/codex/fixtures/codexChildFixtures'
import { CodexChildRollouts } from './codexChildRollouts'
import { CodexRolloutIndex } from './codexRolloutIndex'

describe('lib-orchestrator/projectManager/providers/codex/codexChildRollouts', () => {
  const created: string[] = []
  const parentConst = CodexChildFixtures.parentThreadIdConst
  const sessionStartConst = new Date(2026, 9, 11, 20, 0, 0)

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function codexHome(): string {
    const value = mkdtempSync(join(tmpdir(), 'jamat-codex-children-'))
    created.push(value)
    return value
  }

  function at(minutes: number): Date {
    return new Date(sessionStartConst.getTime() + minutes * 60_000)
  }

  /** The parent, two children, one grandchild and an unrelated session, all on the session's day. */
  function family(home: string): void {
    CodexChildFixtures.write(home, sessionStartConst, parentConst,
      CodexChildFixtures.header(parentConst, null, null, '2026-10-11T18:00:00.000Z'))
    CodexChildFixtures.write(home, at(5), CodexChildFixtures.firstChildIdConst,
      CodexChildFixtures.plainChild(CodexChildFixtures.firstChildIdConst, parentConst, 'Jason', null))
    CodexChildFixtures.write(home, at(6), CodexChildFixtures.secondChildIdConst,
      CodexChildFixtures.encryptedChild(CodexChildFixtures.secondChildIdConst, parentConst, 'Kuhn'))
    CodexChildFixtures.write(home, at(7), CodexChildFixtures.grandchildIdConst,
      CodexChildFixtures.plainChild(CodexChildFixtures.grandchildIdConst, CodexChildFixtures.firstChildIdConst, 'Erdos', null))
    CodexChildFixtures.write(home, at(8), CodexChildFixtures.strangerIdConst,
      CodexChildFixtures.header(CodexChildFixtures.strangerIdConst, null, null, '2026-10-11T18:08:00.000Z'))
  }

  function countingReader(): { read: (file: string, byteLimit: number) => Promise<string>; files: string[] } {
    const files: string[] = []
    return {
      files,
      read: (file, byteLimit) => {
        files.push(file)
        return CodexRolloutIndex.readPrefix(file, byteLimit)
      },
    }
  }

  it('lists two children and the grandchild under its depth-1 child', async () => {
    const home = codexHome()
    family(home)
    const children = new CodexChildRollouts(new CodexRolloutIndex(home, () => {}))

    const found = await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())

    expect(found.map((child) => [child.sessionId, child.depth, child.parentThreadId, child.nickname])).toEqual([
      [CodexChildFixtures.firstChildIdConst, 1, parentConst, 'Jason'],
      [CodexChildFixtures.secondChildIdConst, 1, parentConst, 'Kuhn'],
      [CodexChildFixtures.grandchildIdConst, 2, CodexChildFixtures.firstChildIdConst, 'Erdos'],
    ])
    expect(found[0].createdAt).toBe(at(5).getTime())
  })

  it('never reads a rollout outside the session\'s days', async () => {
    const home = codexHome()
    family(home)
    const dayBefore = new Date(2026, 9, 10, 23, 30, 0)
    const early = CodexChildFixtures.write(home, dayBefore, '01a12c20-0000-7000-8000-000000000001',
      CodexChildFixtures.plainChild('01a12c20-0000-7000-8000-000000000001', parentConst, 'Early', null))
    const reader = countingReader()
    const children = new CodexChildRollouts(new CodexRolloutIndex(home, () => {}), reader.read)

    const found = await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())

    expect(found).toHaveLength(3)
    expect(reader.files).not.toContain(early)
    expect(reader.files).toHaveLength(5)
  })

  it('reads each header once and a new child file once', async () => {
    const home = codexHome()
    family(home)
    const reader = countingReader()
    const children = new CodexChildRollouts(new CodexRolloutIndex(home, () => {}), reader.read)
    await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())
    reader.files.splice(0)

    expect(await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())).toHaveLength(3)
    expect(reader.files).toEqual([])

    const third = CodexChildFixtures.write(home, at(9), '01a12c30-0000-7000-8000-000000000003',
      CodexChildFixtures.plainChild('01a12c30-0000-7000-8000-000000000003', parentConst, 'Bacon', null))
    expect(await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())).toHaveLength(4)
    expect(reader.files).toEqual([third])
    expect(await children.childrenOf(parentConst, sessionStartConst.getTime(), at(60).getTime())).toHaveLength(4)
    expect(reader.files).toEqual([third])
  })

  it('takes header fields only from the session_meta line before the instructions', () => {
    const own = CodexChildFixtures.header(parentConst, null, null, '2026-10-11T18:00:00.000Z')
    expect(CodexChildRollouts.headerOf(own)).toBeNull()
    expect(CodexChildRollouts.headerOf(CodexChildFixtures.header('child', parentConst, 'Kuhn', '2026-10-11T18:00:00.000Z')))
      .toEqual({ parentThreadId: parentConst, nickname: 'Kuhn' })
    // A header still being written tells nothing yet, so nothing is remembered.
    expect(CodexChildRollouts.headerOf('{"timestamp":"2026-10-11T18:00:00.000Z","type":"session_meta"')).toBeUndefined()
    expect(CodexChildRollouts.headerOf('')).toBeUndefined()
  })
})
