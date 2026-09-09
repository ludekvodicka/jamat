import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexRolloutCwdMemo } from './codexRolloutCwdMemo'
import { CodexRolloutIndex } from './codexRolloutIndex'

describe('lib-orchestrator/projectManager/providers/codex/codexRolloutIndex', () => {
  const created: string[] = []
  const projectDir = 'Q:/Projects/AppFixture'
  const forwardSlashId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
  const backslashId = '019f4c11-2a3b-7c4d-8e5f-6a7b8c9d0e1f'
  const headerlessId = '019f4d22-3b4c-8d5e-9f60-1a2b3c4d5e6f'
  const extraId = '019f4e33-4c5d-9e6f-a071-2b3c4d5e6f70'
  /**
   * Whole seconds, so a file written twice can be given back the exact mtime it had. The memo keys
   * an answer to the file's stamp, and a millisecond of drift is a miss - which is right in
   * production and useless in a test that wants to observe whether anything reopened the file.
   */
  const frozenSecondsConst = 1_780_000_000

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    codexHome: string
    reports: string[]
    index: CodexRolloutIndex
  }

  function harness(): Harness {
    const codexHome = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-index-'))
    created.push(codexHome)
    const reports: string[] = []
    return { codexHome, reports, index: new CodexRolloutIndex(codexHome, (m) => reports.push(m)) }
  }

  interface RememberingHarness extends Harness {
    memoFile: string
    remembered(): Record<string, unknown>
    rebuilt(): CodexRolloutIndex
  }

  /** The same index with somewhere to remember the headers it read. */
  function remembering(): RememberingHarness {
    const codexHome = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-memo-index-'))
    created.push(codexHome)
    const reports: string[] = []
    const memoFile = join(codexHome, 'state', 'codex-rollout-cwd.json')
    const sessionsRoot = join(codexHome, 'sessions')
    const report = (message: string): void => { reports.push(message) }
    const build = (): CodexRolloutIndex => new CodexRolloutIndex(
      codexHome,
      report,
      new CodexRolloutCwdMemo(memoFile, sessionsRoot, report),
    )
    return {
      codexHome,
      reports,
      memoFile,
      index: build(),
      rebuilt: build,
      remembered: () => JSON.parse(readFileSync(memoFile, 'utf8')).cwdByFile as Record<string, unknown>,
    }
  }

  /**
   * Takes the header away and leaves the file's stamp exactly where it was - same byte count, same
   * mtime - so the only thing that can tell the difference is a walk that actually reopened it.
   */
  function blankHeaderKeepingStamp(file: string): void {
    const size = statSync(file).size
    const blank = Buffer.from(fixture('rollout-no-header.jsonl'), 'utf8')
    writeFileSync(file, blank.length >= size
      ? blank.subarray(0, size)
      : Buffer.concat([blank, Buffer.alloc(size - blank.length, 0x20)]))
    utimesSync(file, frozenSecondsConst, frozenSecondsConst)
  }

  function fixture(name: string): string {
    return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
  }

  function pad(value: number): string {
    return String(value).padStart(2, '0')
  }

  function newestFirst(written: readonly { file: string; createdAt: number }[]): string[] {
    return [...written]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((entry) => entry.file)
  }

  /**
   * Places a fixture where Codex would have filed it `daysAgo` days back. `cwd` retargets the
   * forward-slashed spelling the fixtures record, which is how one batch can hold two projects.
   */
  function writeRollout(
    codexHome: string,
    options: { daysAgo: number; sessionId: string; fixture: string; cwd?: string },
  ): { file: string; createdAt: number } {
    return writeRolloutAt(codexHome, { ...options, at: Date.now() - options.daysAgo * 86_400_000 })
  }

  /**
   * The same, at a moment named outright rather than counted back from now. What reads a slice of the
   * store takes the moment from its caller and never from the clock, so its tests can too.
   */
  function writeRolloutAt(
    codexHome: string,
    options: { at: number; sessionId: string; fixture: string; cwd?: string },
  ): { file: string; createdAt: number } {
    const at = new Date(options.at)
    const year = String(at.getFullYear())
    const month = pad(at.getMonth() + 1)
    const day = pad(at.getDate())
    const stamp = `${year}-${month}-${day}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
    const directory = join(codexHome, 'sessions', year, month, day)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `rollout-${stamp}-${options.sessionId}.jsonl`)
    const content = fixture(options.fixture)
    writeFileSync(file, options.cwd ? content.split(projectDir).join(options.cwd) : content, 'utf8')
    utimesSync(file, frozenSecondsConst, frozenSecondsConst)
    return { file, createdAt: Date.parse(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')) }
  }

  // The project is not in the path: it comes out of the header, spelled however the shell spelled it.
  it('groups rollouts by the cwd their header records', async () => {
    const { codexHome, index, reports } = harness()
    const forward = writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    const backslash = writeRollout(codexHome, { daysAgo: 3, sessionId: backslashId, fixture: 'rollout-event-user-message.jsonl' })

    const found = await index.filesForProject(projectDir)
    expect(found).toEqual([
      { file: forward.file, sessionId: forwardSlashId, createdAt: forward.createdAt },
      { file: backslash.file, sessionId: backslashId, createdAt: backslash.createdAt },
    ])
    expect(reports).toEqual([])
  })

  it('matches a project directory spelled with other separators, case or a trailing slash', async () => {
    const { codexHome, index } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })

    for (const spelling of ['Q:/Projects/AppFixture/', 'q:/projects/appfixture', 'Q:\\Projects\\AppFixture'])
      expect((await index.filesForProject(spelling)).map((ref) => ref.sessionId), spelling)
        .toEqual([forwardSlashId])
    expect(await index.filesForProject('Q:/Projects/Other')).toEqual([])
  })

  // A cold build over a 25k-rollout history is what the window exists to prevent.
  it('leaves rollouts outside the ninety day window unread', async () => {
    const { codexHome, index, reports } = harness()
    const fresh = writeRollout(codexHome, { daysAgo: 2, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    writeRollout(codexHome, { daysAgo: 120, sessionId: backslashId, fixture: 'rollout-event-user-message.jsonl' })
    writeRollout(codexHome, { daysAgo: 150, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })

    expect((await index.filesForProject(projectDir)).map((ref) => ref.file)).toEqual([fresh.file])
    // The old headerless file would have reported itself had anything opened it.
    expect(reports).toEqual([])
  })

  it('skips a rollout without a recognizable header, reports it and keeps the rest', async () => {
    const { codexHome, index, reports } = harness()
    const fresh = writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    const headerless = writeRollout(codexHome, { daysAgo: 1, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })

    expect((await index.filesForProject(projectDir)).map((ref) => ref.file)).toEqual([fresh.file])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain(headerless.file)
    expect(reports[0]).toMatch(/no session_meta cwd/)
  })

  it('ignores names that are not date directories or rollouts, without reporting them', async () => {
    const { codexHome, index, reports } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    mkdirSync(join(codexHome, 'sessions', 'latest'), { recursive: true })
    writeFileSync(join(codexHome, 'sessions', 'latest', 'pointer.txt'), 'x', 'utf8')
    writeFileSync(join(codexHome, 'sessions', 'README.md'), 'x', 'utf8')

    expect(await index.filesForProject(projectDir)).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it('builds once and rebuilds only after invalidate', async () => {
    const { codexHome, index, reports } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    // Every build reports this one file, so the report count counts the walks.
    writeRollout(codexHome, { daysAgo: 1, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })

    expect(await index.filesForProject(projectDir)).toHaveLength(1)
    expect(reports).toHaveLength(1)

    const added = writeRollout(codexHome, { daysAgo: 1, sessionId: extraId, fixture: 'rollout-event-user-message.jsonl' })
    expect(await index.filesForProject(projectDir)).toHaveLength(1)
    expect(reports).toHaveLength(1)

    index.invalidate()
    const afterInvalidate = await index.filesForProject(projectDir)
    expect(afterInvalidate.map((ref) => ref.file)).toContain(added.file)
    expect(afterInvalidate).toHaveLength(2)
    expect(reports).toHaveLength(2)
  })

  it('serves concurrent callers from a single build', async () => {
    const { codexHome, index, reports } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
    writeRollout(codexHome, { daysAgo: 1, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })

    const [first, second] = await Promise.all([
      index.filesForProject(projectDir),
      index.filesForProject(projectDir),
    ])
    expect(first).toEqual(second)
    expect(reports).toHaveLength(1)
  })

  it('returns nothing for a codex home that does not exist', async () => {
    const { codexHome, reports } = harness()
    const index = new CodexRolloutIndex(join(codexHome, 'missing'), (m) => reports.push(m))
    expect(await index.filesForProject(projectDir)).toEqual([])
    expect(reports).toEqual([])
  })

  /**
   * The headers are read through a pool, so they finish out of order. What must not move is the
   * pairing: the cwd at position `i` belongs to the candidate at position `i`, and a fold that
   * collected in completion order would hand one project's rollouts to the other. Two projects
   * interleaved, one unreadable header in the middle to shift everything behind it, and more
   * rollouts than the pool is wide.
   */
  it('builds the same map however the concurrent reads finish', async () => {
    const { codexHome, index, reports } = harness()
    const otherDir = 'Q:/Projects/AppSecond'
    const mine: { file: string; createdAt: number }[] = []
    const theirs: { file: string; createdAt: number }[] = []
    let headerless = ''
    for (let day = 1; day <= 40; day += 1) {
      const sessionId = `019f4bf7-b5d8-74b0-9175-${String(day).padStart(12, '0')}`
      if (day === 20) {
        headerless = writeRollout(codexHome, { daysAgo: day, sessionId, fixture: 'rollout-no-header.jsonl' }).file
        continue
      }
      const written = writeRollout(codexHome, {
        daysAgo: day,
        sessionId,
        fixture: 'rollout-injected-blocks.jsonl',
        cwd: day % 2 === 0 ? otherDir : undefined,
      })
      if (day % 2 === 0) theirs.push(written)
      else mine.push(written)
    }

    const found = await index.allFilesForProject(projectDir)
    const second = await index.allFilesForProject(otherDir)

    expect(found.map((ref) => ref.file)).toEqual(newestFirst(mine))
    expect(second.map((ref) => ref.file)).toEqual(newestFirst(theirs))
    // Two whole-store walks, neither of them cached, so the one unreadable file is named twice.
    expect(reports).toHaveLength(2)
    expect(reports.every((message) => message.includes(headerless))).toBe(true)
  })

  it('hands back a copy, so a caller cannot edit the index', async () => {
    const { codexHome, index } = harness()
    writeRollout(codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })

    const found = await index.filesForProject(projectDir)
    found.length = 0
    expect(await index.filesForProject(projectDir)).toHaveLength(1)
  })

  /**
   * The reason the memo exists: `allFilesForProject` walks the whole store on every call, and a
   * heavy history holds 25 000 rollouts. Emptying the headers between the two walks - and putting
   * the file's stamp back, which is what the memo checks - is how a test observes that the second
   * walk opened nothing.
   */
  describe('with somewhere to remember what it read', () => {
    it('does not open a rollout whose header it has already read', async () => {
      const remember = remembering()
      const fresh = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      expect(await remember.index.allFilesForProject(projectDir)).toHaveLength(1)

      blankHeaderKeepingStamp(fresh.file)
      const again = remember.rebuilt()

      expect((await again.allFilesForProject(projectDir)).map((ref) => ref.file)).toEqual([fresh.file])
      expect(remember.reports).toEqual([])
    })

    it('remembers what the ninety day window read, so the whole-store walk skips it too', async () => {
      const remember = remembering()
      const fresh = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      const old = writeRollout(remember.codexHome, { daysAgo: 200, sessionId: backslashId, fixture: 'rollout-event-user-message.jsonl' })
      expect(await remember.index.filesForProject(projectDir)).toHaveLength(1)

      // Only the windowed walk has run, so only the fresh one can be remembered.
      expect(Object.keys(remember.remembered())).toHaveLength(1)
      blankHeaderKeepingStamp(fresh.file)

      const whole = await remember.rebuilt().allFilesForProject(projectDir)

      // The fresh one came out of the memo; the old one was opened for the first time here.
      expect(whole.map((ref) => ref.file).sort()).toEqual([fresh.file, old.file].sort())
      expect(remember.reports).toEqual([])
    })

    /**
     * The migrator is not the only thing that rewrites a recorded cwd - the startup sweep retries
     * whatever a relocation left locked, at a later start and telling nobody. So an entry is not
     * taken on its word: it names the mtime and the size the answer was read from.
     */
    it('reads a rollout again when its header was rewritten and nothing said so', async () => {
      const remember = remembering()
      const moved = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      expect(await remember.index.allFilesForProject(projectDir)).toHaveLength(1)

      // The same length as the path it replaces, so only the mtime can give the rewrite away.
      const renamed = 'Q:/Projects/AppRenamed'
      writeFileSync(moved.file, readFileSync(moved.file, 'utf8').split(projectDir).join(renamed), 'utf8')

      const after = remember.rebuilt()
      expect((await after.allFilesForProject(renamed)).map((ref) => ref.file)).toEqual([moved.file])
      expect(await after.allFilesForProject(projectDir)).toEqual([])
      expect(remember.reports).toEqual([])
    })

    it('forgets a rollout only when the walk that missed it saw the whole store', async () => {
      const remember = remembering()
      writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      const old = writeRollout(remember.codexHome, { daysAgo: 200, sessionId: backslashId, fixture: 'rollout-event-user-message.jsonl' })
      await remember.index.allFilesForProject(projectDir)
      expect(Object.keys(remember.remembered())).toHaveLength(2)

      // The windowed walk cannot see the old rollout at all, so its absence proves nothing.
      rmSync(old.file)
      await remember.rebuilt().filesForProject(projectDir)
      expect(Object.keys(remember.remembered())).toHaveLength(2)

      await remember.rebuilt().allFilesForProject(projectDir)

      expect(Object.keys(remember.remembered())).toHaveLength(1)
    })

    /** A sessions directory nothing can read answers [], which is a failed walk and not an empty store. */
    it('keeps what it remembered when a whole-store walk finds nothing at all', async () => {
      const remember = remembering()
      writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      writeRollout(remember.codexHome, { daysAgo: 200, sessionId: backslashId, fixture: 'rollout-event-user-message.jsonl' })
      await remember.index.allFilesForProject(projectDir)
      expect(Object.keys(remember.remembered())).toHaveLength(2)

      rmSync(join(remember.codexHome, 'sessions'), { recursive: true, force: true })
      expect(await remember.rebuilt().allFilesForProject(projectDir)).toEqual([])

      expect(Object.keys(remember.remembered())).toHaveLength(2)
    })

    /**
     * The migrator's shortcut, and what the smoke run found when it was missing: the memo went on
     * naming the path the move had just replaced. It is no longer what makes the answer correct -
     * the rewrite moves the file's stamp, so the header would be read again either way - so what
     * this holds is its SCOPE: the rollouts of the project that moved leave the memo, and the other
     * 25 000 stay.
     */
    it('forgets the rollouts of the project whose directory was rewritten, and only those', async () => {
      const remember = remembering()
      const moved = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      writeRollout(remember.codexHome, { daysAgo: 1, sessionId: extraId, fixture: 'rollout-injected-blocks.jsonl', cwd: 'Q:/Projects/AppSecond' })
      await remember.index.allFilesForProject(projectDir)
      expect(Object.keys(remember.remembered())).toHaveLength(2)

      // What the migrator does to the file, and then what it tells the index about it.
      const renamed = 'Q:/Projects/AppRenamed'
      writeFileSync(
        moved.file,
        readFileSync(moved.file, 'utf8').split(projectDir).join(renamed),
        'utf8',
      )
      remember.index.forgetProject(projectDir)

      expect(Object.keys(remember.remembered())).toHaveLength(1)
      const after = remember.rebuilt()
      expect((await after.allFilesForProject(renamed)).map((ref) => ref.file)).toEqual([moved.file])
      expect(await after.allFilesForProject(projectDir)).toEqual([])
      expect(remember.reports).toEqual([])
    })

    /** What the startup sweep says when it rewrites one rollout a relocation had left locked. */
    it('forgets a single named rollout and leaves the rest of the project remembered', async () => {
      const remember = remembering()
      const swept = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      writeRollout(remember.codexHome, { daysAgo: 1, sessionId: extraId, fixture: 'rollout-injected-blocks.jsonl' })
      await remember.index.allFilesForProject(projectDir)
      expect(Object.keys(remember.remembered())).toHaveLength(2)

      remember.index.forgetFile(swept.file)

      expect(Object.keys(remember.remembered())).toHaveLength(1)
    })

    it('tries a rollout it could not read again, rather than remembering the failure', async () => {
      const remember = remembering()
      const broken = writeRollout(remember.codexHome, { daysAgo: 1, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })
      expect(await remember.index.allFilesForProject(projectDir)).toEqual([])
      expect(remember.reports).toHaveLength(1)

      writeFileSync(broken.file, fixture('rollout-injected-blocks.jsonl'), 'utf8')

      expect((await remember.rebuilt().allFilesForProject(projectDir)).map((ref) => ref.file))
        .toEqual([broken.file])
    })
  })

  /**
   * The narrow read, for a Codex session that has just started and needs to know which rollout is
   * its own. Every moment here is named outright: this path never asks the clock.
   */
  describe('rolloutsBetween', () => {
    const noonConst = Date.parse('2026-08-17T12:00:00')
    const hour = 3_600_000
    const forkedId = '019f4c22-7a11-7b33-9c44-1d2e3f405162'

    /** Rewrite a rollout in place, keeping the frozen stamp the harness gives every file. */
    function rewrite(file: string, edit: (content: string) => string): void {
      writeFileSync(file, edit(readFileSync(file, 'utf8')), 'utf8')
      utimesSync(file, frozenSecondsConst, frozenSecondsConst)
    }

    it('answers with the rollouts of this project written inside the window', async () => {
      const { codexHome, index, reports } = harness()
      const wanted = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      const earlier = writeRolloutAt(codexHome, { at: noonConst - hour, sessionId: extraId, fixture: 'rollout-injected-blocks.jsonl' })
      const other = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: backslashId, fixture: 'rollout-injected-blocks.jsonl', cwd: 'Q:/Projects/Other' })

      expect(await index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour)).toEqual([
        { file: wanted.file, sessionId: forwardSlashId, createdAt: wanted.createdAt, forkedFromId: null },
      ])
      expect(earlier.file).not.toEqual(other.file)
      expect(reports).toEqual([])
    })

    /**
     * The parent link, and only from the header LINE: the fixture's second line quotes the same key
     * back at a different id on purpose, because a rollout that named a parent it was not cut from
     * is the one mistake this field exists to prevent.
     */
    it('carries the conversation each rollout was forked from', async () => {
      const { codexHome, index, reports } = harness()
      const forked = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forkedId, fixture: 'rollout-forked.jsonl' })

      expect(await index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour)).toEqual([
        { file: forked.file, sessionId: forkedId, createdAt: forked.createdAt, forkedFromId: forwardSlashId },
      ])
      expect(reports).toEqual([])
    })

    // Codex writes the field as `null` for a session nobody forked; the 0.44.0 fixtures omit it.
    it('reads a null parent, and an absent one, as no parent at all', async () => {
      const { codexHome, index } = harness()
      const forked = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forkedId, fixture: 'rollout-forked.jsonl' })
      rewrite(forked.file, (content) =>
        content.replace(`"forked_from_id":"${forwardSlashId}"`, '"forked_from_id":null'))

      expect((await index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour))[0]?.forkedFromId)
        .toBeNull()
    })

    // The cwd still decides whether a file counts at all, and says so in the same sentence as before.
    it('reports and skips a rollout whose header names no cwd', async () => {
      const { codexHome, index, reports } = harness()
      const forked = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forkedId, fixture: 'rollout-forked.jsonl' })
      rewrite(forked.file, (content) => content.split(`"cwd":"${projectDir}",`).join(''))

      expect(await index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour)).toEqual([])
      expect(reports).toEqual([
        `Codex rollout ${forked.file} has no session_meta cwd in its first 16384 bytes; skipping it`,
      ])
    })

    /**
     * The walk owes the memo nothing in either direction. A remembered cwd that disagrees with the
     * file is what proves the read side: the walk answers from the header regardless, and the memo
     * is left exactly as the listing wrote it.
     */
    it('neither reads nor writes the cwd memo', async () => {
      const remember = remembering()
      const wanted = writeRolloutAt(remember.codexHome, { at: noonConst + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      await remember.index.allFilesForProject(projectDir)
      const memo = JSON.parse(readFileSync(remember.memoFile, 'utf8')) as {
        cwdByFile: Record<string, { cwd: string }>
      }
      const memoKey = Object.keys(memo.cwdByFile)[0]
      expect(Object.keys(memo.cwdByFile)).toHaveLength(1)
      memo.cwdByFile[memoKey].cwd = 'Q:/Projects/Wrong'
      writeFileSync(remember.memoFile, JSON.stringify(memo), 'utf8')

      const walked = remember.rebuilt()
      expect((await walked.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour)).map((ref) => ref.file))
        .toEqual([wanted.file])
      expect((JSON.parse(readFileSync(remember.memoFile, 'utf8')) as typeof memo).cwdByFile[memoKey].cwd)
        .toBe('Q:/Projects/Wrong')
    })

    /**
     * The point of the whole method, and the reason it is not `filesForProject`: a header it has no
     * business reading is a file it never opens. The older day's rollout has no readable header at
     * all, so opening it would report - and the report is what the assertion is on.
     */
    it('opens nothing outside the days the moment touches', async () => {
      const { codexHome, index, reports } = harness()
      writeRolloutAt(codexHome, { at: noonConst - 3 * 86_400_000, sessionId: headerlessId, fixture: 'rollout-no-header.jsonl' })
      const wanted = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      writeRolloutAt(codexHome, { at: noonConst + 3 * 86_400_000, sessionId: extraId, fixture: 'rollout-no-header.jsonl' })

      expect((await index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour))
        .map((ref) => ref.file))
        .toEqual([wanted.file])
      expect(reports).toEqual([])
      // The same store through the listing path DOES read it, which is what makes the silence above
      // a property of this method rather than of the fixture.
      await index.filesForProject(projectDir)
      expect(reports).toHaveLength(2)
    })

    /*
     * The day the clock goes BACK is 25 hours long. The end of a day used to be its start plus a
     * constant 86 400 000, so on that one day it fell an hour early: a rollout written between 23:00
     * and midnight sat in a directory the scan decided was already over, and a Codex session started
     * then could not find its own rollout at reconcile or at startup recovery.
     *
     * The zone is set here rather than taken from the machine: on a machine that keeps a fixed
     * offset this bug does not exist, so a test that read the local zone would pass by being in the
     * wrong place. Node reads `process.env.TZ` per call, so the dates below are Prague dates.
     */
    it('takes the whole of the day the clock goes back, which is 25 hours', async () => {
      const zone = process.env.TZ
      process.env.TZ = 'Europe/Prague'
      try {
        const { codexHome, index } = harness()
        // 2026-10-25 is the Sunday the European clocks go back; 23:30 is inside the long day.
        const lateOnTheLongDay = new Date(2026, 9, 25, 23, 30).getTime()
        const written = writeRolloutAt(codexHome, {
          at: lateOnTheLongDay,
          sessionId: forwardSlashId,
          fixture: 'rollout-injected-blocks.jsonl',
        })

        expect((await index.rolloutsBetween(projectDir, lateOnTheLongDay, lateOnTheLongDay + hour))
          .map((ref) => ref.file))
          .toEqual([written.file])
      } finally {
        process.env.TZ = zone
      }
    })

    it('crosses midnight forwards and not backwards', async () => {
      const { codexHome, index } = harness()
      const lateNight = Date.parse('2026-08-17T23:30:00')
      const before = writeRolloutAt(codexHome, { at: lateNight - hour, sessionId: extraId, fixture: 'rollout-injected-blocks.jsonl' })
      const after = writeRolloutAt(codexHome, { at: lateNight + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })

      expect((await index.rolloutsBetween(projectDir, lateNight, lateNight + 2 * hour))
        .map((ref) => ref.file))
        .toEqual([after.file])
      expect((await index.rolloutsBetween(projectDir, before.createdAt, lateNight + 2 * hour))
        .map((ref) => ref.file))
        .toEqual([after.file, before.file])
    })

    /** Nothing is cached, or a session started a second ago would be invisible for thirty of them. */
    it('walks again for every ask', async () => {
      const { codexHome, index } = harness()
      const first = writeRolloutAt(codexHome, { at: noonConst + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })
      expect((await index.rolloutsBetween(projectDir, noonConst, noonConst + 3 * hour))
        .map((ref) => ref.file)).toEqual([first.file])

      const second = writeRolloutAt(codexHome, { at: noonConst + 2 * hour, sessionId: extraId, fixture: 'rollout-injected-blocks.jsonl' })

      expect((await index.rolloutsBetween(projectDir, noonConst, noonConst + 3 * hour))
        .map((ref) => ref.file))
        .toEqual([second.file, first.file])
    })

    /** Read-only by construction: a slice of the store may never be written back as the store. */
    it('remembers nothing, even on an index that has a memo', async () => {
      const remember = remembering()
      writeRolloutAt(remember.codexHome, { at: noonConst + hour, sessionId: forwardSlashId, fixture: 'rollout-injected-blocks.jsonl' })

      expect(await remember.index.rolloutsBetween(projectDir, noonConst, noonConst + 2 * hour))
        .toHaveLength(1)

      expect(existsSync(remember.memoFile)).toBe(false)
    })
  })
})
