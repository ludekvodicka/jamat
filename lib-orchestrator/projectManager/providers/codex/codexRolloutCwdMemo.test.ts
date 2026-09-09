import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RolloutStamp } from './codexRolloutCwdMemo'
import { CodexRolloutCwdMemo } from './codexRolloutCwdMemo'

describe('lib-orchestrator/projectManager/providers/codex/codexRolloutCwdMemo', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    root: string
    file: string
    sessionsRoot: string
    reports: string[]
    memo: CodexRolloutCwdMemo
  }

  function harness(options?: { sessionsRoot?: string }): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-memo-'))
    created.push(root)
    const file = join(root, 'state', 'codex-rollout-cwd.json')
    const sessionsRoot = options?.sessionsRoot ?? join(root, 'codex', 'sessions')
    const reports: string[] = []
    return {
      root,
      file,
      sessionsRoot,
      reports,
      memo: new CodexRolloutCwdMemo(file, sessionsRoot, (message) => reports.push(message)),
    }
  }

  function rollout(sessionsRoot: string, day: string, name: string): string {
    return join(sessionsRoot, '2026', '08', day, `rollout-2026-08-${day}T10-15-00-${name}.jsonl`)
  }

  /** Whatever the file looked like when its header was read; only equality matters here. */
  function stamp(value: number): RolloutStamp {
    return { mtimeMs: 1_780_000_000_000 + value, size: 4_096 + value }
  }

  function reopen(harnessed: Harness): CodexRolloutCwdMemo {
    return new CodexRolloutCwdMemo(
      harnessed.file,
      harnessed.sessionsRoot,
      (message) => harnessed.reports.push(message),
    )
  }

  it('answers nothing before anything was remembered', () => {
    const { memo, sessionsRoot, reports } = harness()

    expect(memo.get(rollout(sessionsRoot, '11', 'a'), stamp(1))).toBeNull()
    expect(reports).toEqual([])
  })

  it('hands back across a restart what one run remembered', () => {
    const first = harness()
    const file = rollout(first.sessionsRoot, '11', 'a')
    first.memo.set(file, 'C:/Projects/NodeJs/AppJamatV3', stamp(1))
    first.memo.save()

    expect(reopen(first).get(file, stamp(1))).toBe('C:/Projects/NodeJs/AppJamatV3')
    expect(first.reports).toEqual([])
  })

  /**
   * The whole invalidation story: this library rewrites a rollout's header in place, and neither the
   * migrator nor the startup sweep has to say so for the answer to stop being handed out.
   */
  it('answers nothing for a file whose stamp moved since the header was read', () => {
    const harnessed = harness()
    const file = rollout(harnessed.sessionsRoot, '11', 'a')
    harnessed.memo.set(file, 'Q:/Projects/Foo', stamp(1))

    expect(harnessed.memo.get(file, stamp(2))).toBeNull()
    expect(harnessed.memo.get(file, stamp(1))).toBe('Q:/Projects/Foo')
  })

  /** Writing megabytes back on a walk that learned nothing would make every listing an I/O of its own. */
  it('writes only when something changed', () => {
    const harnessed = harness()
    const file = rollout(harnessed.sessionsRoot, '11', 'a')
    harnessed.memo.set(file, 'Q:/Projects/Foo', stamp(1))
    harnessed.memo.save()
    const first = readFileSync(harnessed.file, 'utf8')

    // Setting the same answer again is what every later walk over an unchanged store does.
    harnessed.memo.set(file, 'Q:/Projects/Foo', stamp(1))
    writeFileSync(harnessed.file, 'clobbered', 'utf8')
    harnessed.memo.save()

    expect(readFileSync(harnessed.file, 'utf8')).toBe('clobbered')
    expect(first).toContain('Q:/Projects/Foo')
  })

  it('forgets a rollout the whole-store walk no longer saw, and keeps the ones it did', () => {
    const harnessed = harness()
    const kept = rollout(harnessed.sessionsRoot, '11', 'a')
    const gone = rollout(harnessed.sessionsRoot, '10', 'b')
    harnessed.memo.set(kept, 'Q:/Projects/Kept', stamp(1))
    harnessed.memo.set(gone, 'Q:/Projects/Gone', stamp(2))

    harnessed.memo.prune([kept])
    harnessed.memo.save()

    const reopened = reopen(harnessed)
    expect(reopened.get(kept, stamp(1))).toBe('Q:/Projects/Kept')
    expect(reopened.get(gone, stamp(2))).toBeNull()
  })

  /**
   * A rename forgets ONE project's rollouts. The other 25 000 are the reason this class has a file:
   * a `forget` that cleared everything would be a correct cache and a useless one.
   */
  it('forgets only the rollouts whose recorded directory the predicate matches', () => {
    const harnessed = harness()
    const moved = rollout(harnessed.sessionsRoot, '11', 'a')
    const stayed = rollout(harnessed.sessionsRoot, '10', 'b')
    harnessed.memo.set(moved, 'Q:/Projects/Moved', stamp(1))
    harnessed.memo.set(stayed, 'Q:/Projects/Stayed', stamp(2))

    harnessed.memo.forget((cwd) => cwd === 'Q:/Projects/Moved')

    expect(harnessed.memo.get(moved, stamp(1))).toBeNull()
    expect(harnessed.memo.get(stayed, stamp(2))).toBe('Q:/Projects/Stayed')
  })

  it('forgets one named rollout and nothing beside it', () => {
    const harnessed = harness()
    const swept = rollout(harnessed.sessionsRoot, '11', 'a')
    const untouched = rollout(harnessed.sessionsRoot, '11', 'b')
    harnessed.memo.set(swept, 'Q:/Projects/Same', stamp(1))
    harnessed.memo.set(untouched, 'Q:/Projects/Same', stamp(2))

    harnessed.memo.forgetFile(swept)

    expect(harnessed.memo.get(swept, stamp(1))).toBeNull()
    expect(harnessed.memo.get(untouched, stamp(2))).toBe('Q:/Projects/Same')
  })

  it('is an empty memo, not a failure, when the file cannot be read', () => {
    const harnessed = harness()
    harnessed.memo.set(rollout(harnessed.sessionsRoot, '11', 'a'), 'Q:/Projects/Foo', stamp(1))
    harnessed.memo.save()
    writeFileSync(harnessed.file, '{ not json', 'utf8')

    const reopened = reopen(harnessed)

    expect(reopened.get(rollout(harnessed.sessionsRoot, '11', 'a'), stamp(1))).toBeNull()
    expect(harnessed.reports).toHaveLength(1)
    expect(harnessed.reports[0]).toContain('unreadable')
  })

  /** Version 1 held a bare cwd with nothing to check it against - the answer this class must not trust. */
  it('discards a document written before entries carried a stamp', () => {
    const harnessed = harness()
    const file = rollout(harnessed.sessionsRoot, '11', 'a')
    harnessed.memo.set(file, 'Q:/Projects/Foo', stamp(1))
    harnessed.memo.save()
    const document = JSON.parse(readFileSync(harnessed.file, 'utf8'))
    const key = Object.keys(document.cwdByFile)[0]
    writeFileSync(
      harnessed.file,
      JSON.stringify({ ...document, schemaVersion: 1, cwdByFile: { [key]: 'Q:/Projects/Foo' } }),
      'utf8',
    )

    expect(reopen(harnessed).get(file, stamp(1))).toBeNull()
    expect(harnessed.reports[0]).toContain('unsupported schema version')
  })

  /**
   * The smoke run and the tests point a ProjectManager at a temporary Codex store while the real one
   * still exists. Recognising that the document was built somewhere else is cheaper, and more
   * honest, than trusting that two stores never name the same relative path.
   */
  it('discards a memo that was built over another store', () => {
    const harnessed = harness()
    harnessed.memo.set(rollout(harnessed.sessionsRoot, '11', 'a'), 'Q:/Projects/Foo', stamp(1))
    harnessed.memo.save()

    const elsewhere = new CodexRolloutCwdMemo(
      harnessed.file,
      join(harnessed.root, 'another-codex', 'sessions'),
      (message) => harnessed.reports.push(message),
    )

    expect(elsewhere.get(rollout(join(harnessed.root, 'another-codex', 'sessions'), '11', 'a'), stamp(1)))
      .toBeNull()
    expect(harnessed.reports[0]).toContain('built over')
  })

  /** A state directory that refuses one write refuses the next; every walk would say so again. */
  it('reports a memo it cannot write once, then stops trying', () => {
    const harnessed = harness()
    // The directory the file would go in is a file, so creating it fails.
    writeFileSync(join(harnessed.root, 'state'), 'in the way', 'utf8')
    const file = rollout(harnessed.sessionsRoot, '11', 'a')
    harnessed.memo.set(file, 'Q:/Projects/Foo', stamp(1))

    harnessed.memo.save()
    harnessed.memo.set(rollout(harnessed.sessionsRoot, '12', 'b'), 'Q:/Projects/Bar', stamp(2))
    harnessed.memo.save()

    expect(harnessed.memo.get(file, stamp(1))).toBe('Q:/Projects/Foo')
    expect(harnessed.reports).toHaveLength(1)
    expect(harnessed.reports[0]).toContain('could not be written')
  })
})
