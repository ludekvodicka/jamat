import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexRolloutView } from './codexRolloutView'

describe('lib-orchestrator/projectManager/codexRolloutView', () => {
  const created: string[] = []
  /** The directory the fixture headers name; a rollout for another project is written by replacing it. */
  const fixtureProjectDir = 'Q:/Projects/AppFixture'
  const otherProjectDir = 'Q:/Projects/AppOther'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function home(): string {
    const codexHome = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-view-'))
    created.push(codexHome)
    return codexHome
  }

  /** Yesterday, so the walk crosses a day directory rather than sitting on today's edge. */
  const writtenAtConst = new Date(Date.now() - 86_400_000)

  function writeRollout(
    codexHome: string,
    sessionId: string,
    options?: { cwd?: string; fixture?: string; edit?: (content: string) => string },
  ): void {
    const at = writtenAtConst
    const pad = (value: number): string => String(value).padStart(2, '0')
    const year = String(at.getFullYear())
    const month = pad(at.getMonth() + 1)
    const day = pad(at.getDate())
    const stamp = `${year}-${month}-${day}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
    const directory = join(codexHome, 'sessions', year, month, day)
    mkdirSync(directory, { recursive: true })
    const raw = readFileSync(
      join(
        import.meta.dirname,
        'providers',
        'codex',
        'fixtures',
        options?.fixture ?? 'rollout-injected-blocks.jsonl',
      ),
      'utf8',
    )
    const retargeted = options?.cwd ? raw.split(fixtureProjectDir).join(options.cwd) : raw
    writeFileSync(
      join(directory, `rollout-${stamp}-${sessionId}.jsonl`),
      options?.edit ? options.edit(retargeted) : retargeted,
      'utf8',
    )
  }

  /** Wide enough to hold everything `writeRollout` writes, narrow enough to be a real window. */
  function window(): { from: number; until: number } {
    return { from: writtenAtConst.getTime() - 3_600_000, until: writtenAtConst.getTime() + 3_600_000 }
  }

  const mineConst = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
  const theirsConst = '019f4c11-2a3b-7c4d-8e5f-6a7b8c9d0e1f'
  const forkedConst = '019f4c22-7a11-7b33-9c44-1d2e3f405162'
  const parentConst = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'

  it('answers with the rollouts of one directory and nothing else', async () => {
    const codexHome = home()
    writeRollout(codexHome, mineConst)
    writeRollout(codexHome, theirsConst, { cwd: otherProjectDir })

    const view = CodexRolloutView.load({ codexHome, report: () => undefined })
    const { from, until } = window()
    expect(await view.rolloutsBetween(fixtureProjectDir, from, until))
      .toEqual([{ sessionId: mineConst, createdAt: expect.any(Number), forkedFromId: null }])
    expect((await view.rolloutsBetween(otherProjectDir, from, until)).map((match) => match.sessionId))
      .toEqual([theirsConst])
  })

  // The parent link is what tells a fork's rollout from a fresh session's started beside it.
  it('carries the conversation a rollout was forked from', async () => {
    const codexHome = home()
    writeRollout(codexHome, forkedConst, { fixture: 'rollout-forked.jsonl' })

    const view = CodexRolloutView.load({ codexHome, report: () => undefined })
    const { from, until } = window()
    expect(await view.rolloutsBetween(fixtureProjectDir, from, until))
      .toEqual([{ sessionId: forkedConst, createdAt: expect.any(Number), forkedFromId: parentConst }])
  })

  // Codex writes the field as `null` for a session nobody forked; an absent field means the same.
  it('reads a null parent as no parent at all', async () => {
    const codexHome = home()
    writeRollout(codexHome, forkedConst, {
      fixture: 'rollout-forked.jsonl',
      edit: (content) => content.replace(`"forked_from_id":"${parentConst}"`, '"forked_from_id":null'),
    })

    const view = CodexRolloutView.load({ codexHome, report: () => undefined })
    const { from, until } = window()
    expect((await view.rolloutsBetween(fixtureProjectDir, from, until))[0]?.forkedFromId).toBeNull()
  })

  // A machine that has never run Codex is the ordinary case, not a failure.
  it('answers with nothing when there is no store to read', async () => {
    const view = CodexRolloutView.load({
      codexHome: join(home(), 'never-used'),
      report: () => undefined,
    })
    const { from, until } = window()
    expect(await view.rolloutsBetween(fixtureProjectDir, from, until)).toEqual([])
  })
})
