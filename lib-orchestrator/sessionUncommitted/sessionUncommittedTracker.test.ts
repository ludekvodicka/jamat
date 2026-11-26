import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import type { ProviderSubagentFileRef, ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import type { SessionUncommittedCandidate } from '../sessionManager/sessionUncommittedView'
import { CommandInvoker } from '../shared/commandInvoker'
import { SvnInvoker } from '../svn/svnInvoker'
import { ClaimCache } from './claims/claimCache'
import { SessionUncommittedTracker } from './sessionUncommittedTracker'

const io = vi.hoisted(() => ({ bytes: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>
      ;(handle as unknown as { read: unknown }).read = async (...readArgs: unknown[]) => {
        const result = await read(...readArgs)
        io.bytes += result.bytesRead
        return result
      }
      return handle
    },
  }
})

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'

/** A working copy with three committed files, and a folder for the transcripts beside it. */
async function fixture(name: string) {
  const root = await fsPromises.mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
  const run = async (cwd: string, args: string[]) => {
    const result = await svn.run(cwd, args)
    expect(result.code, result.stderr).toBe(0)
  }
  const repo = join(root, 'repo'), wc = join(root, 'wc'), transcripts = join(root, 'transcripts')
  expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
  await run(root, ['checkout', pathToFileURL(repo).href, wc])
  for (const file of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(wc, file), `${file}\n`)
  await run(wc, ['add', 'a.txt', 'b.txt', 'c.txt'])
  await run(wc, ['commit', '-m', 'Fixture'])
  mkdirSync(transcripts)
  return { root, wc, transcripts, run }
}

/** Transcript times after the fixture's commit, whose `changed_date` would otherwise end every claim (D7). */
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString()
const prompt = (text: string) => JSON.stringify({ type: 'user', uuid: `u-${text}`, timestamp: iso(), message: { content: text } })
const edit = (id: string, path: string, offset = 0) => [
  JSON.stringify({ type: 'assistant', timestamp: iso(offset), message: { content: [
    { type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] } }),
  JSON.stringify({ type: 'user', timestamp: iso(offset), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
].join('\n')

/** `resolve` finds `<transcripts>/<nativeId>.jsonl`; `subagentFiles` lists what `subagents` holds for the id. */
function transcriptsOf(directory: string, subagents: Map<string, string[]> = new Map()) {
  return {
    resolve: vi.fn(async (input: { agentId: 'claude' | 'codex' | 'antigravity'; nativeSessionId: string }): Promise<ProviderTranscriptRef | null> => {
      const file = join(directory, `${input.nativeSessionId}.jsonl`)
      if (!existsSync(file)) return null
      const stats = statSync(file)
      return { agentId: input.agentId, nativeSessionId: input.nativeSessionId, file, mtimeMs: stats.mtimeMs, size: stats.size }
    }),
    subagentFiles: vi.fn(async (input: { nativeSessionId: string }): Promise<readonly ProviderSubagentFileRef[]> =>
      (subagents.get(input.nativeSessionId) ?? []).map((file, index) => {
        const stats = statSync(file)
        return { agentId: 'claude', subagentId: `s${index}`, file, mtimeMs: stats.mtimeMs, size: stats.size, metaFile: null,
          spawnKey: null, workflowId: null, thread: null }
      })),
  }
}

function candidate(sessionId: string, nativeSessionId: string, cwd: string, life: 'live' | 'ended' = 'live'): SessionUncommittedCandidate {
  return { sessionId, agentId: 'claude', nativeSessionId, cwd, transcriptCwd: cwd, life }
}

function trackerOf(root: string, transcripts: ReturnType<typeof transcriptsOf>) {
  const cache = new ClaimCache(join(root, 'orchestrator', 'session-claims.json'), () => Date.now())
  const tracker = new SessionUncommittedTracker({ transcripts, appData: process.env.APPDATA ?? '', cache, now: () => Date.now() })
  return { tracker, cache }
}

describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('lib-orchestrator/sessionUncommitted/sessionUncommittedTracker', () => {
  it('marks the one of two sessions in a working copy that edited a file, and clears it after a commit', async () => {
    const { root, wc, transcripts, run } = await fixture('tracker-two')
    try {
      writeFileSync(join(transcripts, 'native-1.jsonl'), `${prompt('edit')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(join(transcripts, 'native-2.jsonl'), `${prompt('look')}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      const candidates = [candidate('s1', 'native-1', wc), candidate('s2', 'native-2', wc)]
      expect(await tracker.scan(candidates)).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      await run(wc, ['commit', '-m', 'Commit a'])
      expect(await tracker.scan(candidates)).toEqual({})
      expect(await tracker.claims('s1')).toEqual({ touched: [], shellRuns: [] })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('reads what the transcript added since the last scan before it answers the claims of Finish', async () => {
    const { root, wc, transcripts } = await fixture('tracker-claims')
    try {
      const file = join(transcripts, 'native-1.jsonl')
      writeFileSync(file, `${prompt('edit')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      expect(await tracker.claims('s1')).toBeNull()
      expect(await tracker.scan([candidate('s1', 'native-1', wc)])).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      appendFileSync(file, `${edit('e2', join(wc, 'b.txt'), 1_000)}\n`)
      writeFileSync(join(wc, 'b.txt'), 'changed\n')
      expect(await tracker.claims('s1')).toEqual({ touched: [join(wc, 'a.txt'), join(wc, 'b.txt')], shellRuns: [] })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('decides again only the sessions of the roots a limited scan names, and keeps the other entries', async () => {
    const first = await fixture('tracker-roots-a')
    const second = await fixture('tracker-roots-b')
    try {
      writeFileSync(join(first.transcripts, 'native-1.jsonl'), `${prompt('edit')}\n${edit('e1', join(first.wc, 'a.txt'))}\n`)
      writeFileSync(join(first.transcripts, 'native-2.jsonl'), `${prompt('edit')}\n${edit('e2', join(second.wc, 'b.txt'))}\n`)
      writeFileSync(join(first.wc, 'a.txt'), 'changed\n')
      writeFileSync(join(second.wc, 'b.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(first.root, transcriptsOf(first.transcripts))
      const candidates = [candidate('s1', 'native-1', first.wc), candidate('s2', 'native-2', second.wc)]
      expect(await tracker.scan(candidates)).toEqual({ s1: { files: 1, sample: ['a.txt'] }, s2: { files: 1, sample: ['b.txt'] } })
      await first.run(first.wc, ['commit', '-m', 'Commit a'])
      await second.run(second.wc, ['commit', '-m', 'Commit b'])
      // Only the second root moved as far as the caller knows: the first session keeps its mark.
      expect(await tracker.scan(candidates, [second.wc])).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      expect(await tracker.scan(candidates)).toEqual({})
      await cache.flush()
    } finally {
      await fsPromises.rm(first.root, { recursive: true, force: true })
      await fsPromises.rm(second.root, { recursive: true, force: true })
    }
  })

  it('reads nothing but stat and writes no cache on a second scan with nothing moved', async () => {
    const { root, wc, transcripts } = await fixture('tracker-still')
    try {
      writeFileSync(join(transcripts, 'native-1.jsonl'), `${prompt('edit')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      const source = transcriptsOf(transcripts)
      const { tracker, cache } = trackerOf(root, source)
      const writes = vi.spyOn(cache, 'scheduleWrite')
      const candidates = [candidate('s1', 'native-1', wc)]
      const first = await tracker.scan(candidates)
      expect(writes).toHaveBeenCalledTimes(1)
      expect(source.subagentFiles).toHaveBeenCalledTimes(1)
      io.bytes = 0
      expect(await tracker.scan(candidates)).toEqual(first)
      expect(io.bytes).toBe(0)
      expect(writes).toHaveBeenCalledTimes(1)
      expect(source.subagentFiles).toHaveBeenCalledTimes(1)
      // The transcript file is kept, so a Codex conversation is not looked up among every rollout again.
      expect(source.resolve).toHaveBeenCalledTimes(1)
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('reads no transcript byte on the first scan of a tracker started from a cache whose cursors are at the file ends', async () => {
    const { root, wc, transcripts } = await fixture('tracker-restart')
    try {
      const agent = join(transcripts, 'agent-1.jsonl')
      writeFileSync(join(transcripts, 'native-1.jsonl'), `${prompt('edit')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(agent, `${edit('sub-e1', join(wc, 'b.txt'))}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      writeFileSync(join(wc, 'b.txt'), 'changed\n')
      const candidates = [candidate('s1', 'native-1', wc)]
      const subagents = new Map([['native-1', [agent]]])
      const before = trackerOf(root, transcriptsOf(transcripts, subagents))
      const marked = await before.tracker.scan(candidates)
      expect(marked.s1?.files).toBe(2)
      await before.tracker.flush()

      const after = trackerOf(root, transcriptsOf(transcripts, subagents))
      io.bytes = 0
      expect(await after.tracker.scan(candidates)).toEqual(marked)
      expect(io.bytes).toBe(0)
      await after.cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('keeps reading a conversation the cache names after the record moved on to another one', async () => {
    const { root, wc, transcripts } = await fixture('tracker-cleared')
    try {
      const earlier = join(transcripts, 'native-a.jsonl')
      writeFileSync(earlier, `${prompt('first')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(join(transcripts, 'native-b.jsonl'), `${prompt('after clear')}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      writeFileSync(join(wc, 'b.txt'), 'changed\n')
      const before = trackerOf(root, transcriptsOf(transcripts))
      expect(await before.tracker.scan([candidate('s1', 'native-a', wc)])).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      await before.tracker.flush()
      appendFileSync(earlier, `${edit('e2', join(wc, 'b.txt'), 3_000)}\n`)

      // The record now names only the conversation after `/clear`; the cache still knows the first.
      const after = trackerOf(root, transcriptsOf(transcripts))
      expect(await after.tracker.scan([candidate('s1', 'native-b', wc)])).toEqual({ s1: { files: 2, sample: ['b.txt', 'a.txt'] } })
      await after.cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('marks an ended session with a dirty claim', async () => {
    const { root, wc, transcripts } = await fixture('tracker-ended')
    try {
      writeFileSync(join(transcripts, 'native-1.jsonl'), `${prompt('edit')}\n${edit('e1', join(wc, 'b.txt'))}\n`)
      writeFileSync(join(wc, 'b.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      expect(await tracker.scan([candidate('s1', 'native-1', wc, 'ended')])).toEqual({ s1: { files: 1, sample: ['b.txt'] } })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('counts the claims of both conversations after the session rebinds to a new native id', async () => {
    const { root, wc, transcripts } = await fixture('tracker-rebind')
    try {
      writeFileSync(join(transcripts, 'native-a.jsonl'), `${prompt('first')}\n${edit('e1', join(wc, 'a.txt'))}\n`)
      writeFileSync(join(transcripts, 'native-b.jsonl'), `${prompt('second')}\n${edit('e2', join(wc, 'b.txt'), 5_000)}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      writeFileSync(join(wc, 'b.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      expect(await tracker.scan([candidate('s1', 'native-a', wc)])).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      expect(await tracker.scan([candidate('s1', 'native-b', wc)])).toEqual({ s1: { files: 2, sample: ['b.txt', 'a.txt'] } })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('does not count a claimed path outside every working copy', async () => {
    const { root, wc, transcripts } = await fixture('tracker-outside')
    try {
      writeFileSync(join(transcripts, 'native-1.jsonl'),
        `${prompt('edit')}\n${edit('e1', 'D:/Temp/jamat-outside/x.txt')}\n${edit('e2', join(wc, 'c.txt'), 2_000)}\n`)
      writeFileSync(join(wc, 'c.txt'), 'changed\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      expect(await tracker.scan([candidate('s1', 'native-1', wc)])).toEqual({ s1: { files: 1, sample: ['c.txt'] } })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('takes the edit of a Claude sub-agent file that grew as a claim of the parent session', async () => {
    const { root, wc, transcripts } = await fixture('tracker-subagent')
    try {
      const parent = join(transcripts, 'native-1.jsonl'), agent = join(transcripts, 'agent-1.jsonl')
      writeFileSync(parent, `${prompt('delegate')}\n`)
      writeFileSync(agent, `${JSON.stringify({ type: 'user', isSidechain: true, timestamp: iso(), message: { content: 'Edit a' } })}\n`)
      writeFileSync(join(wc, 'a.txt'), 'changed\n')
      const source = transcriptsOf(transcripts, new Map([['native-1', [agent]]]))
      const { tracker, cache } = trackerOf(root, source)
      const candidates = [candidate('s1', 'native-1', wc)]
      expect(await tracker.scan(candidates)).toEqual({})
      appendFileSync(agent, `${edit('sub-e1', join(wc, 'a.txt'))}\n`)
      expect(await tracker.scan(candidates)).toEqual({ s1: { files: 1, sample: ['a.txt'] } })
      expect(source.subagentFiles).toHaveBeenCalledTimes(1)
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })

  it('takes a status observation of a file a session script wrote as that session\'s claim', async () => {
    const { root, wc, transcripts, run } = await fixture('tracker-status')
    try {
      const startedAt = Date.now() - 2_000
      writeFileSync(join(transcripts, 'native-1.jsonl'), `${prompt('build')}\n${[
        JSON.stringify({ type: 'assistant', timestamp: new Date(startedAt).toISOString(), message: { content: [
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'node build.mjs gen/' } }] } }),
        JSON.stringify({ type: 'user', timestamp: new Date(startedAt + 10_000).toISOString(), message: { content: [
          { type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } }),
      ].join('\n')}\n`)
      await run(wc, ['mkdir', 'gen'])
      await run(wc, ['commit', '-m', 'Generated folder'])
      writeFileSync(join(wc, 'gen', 'out.ts'), 'generated\n')
      const { tracker, cache } = trackerOf(root, transcriptsOf(transcripts))
      const candidates = [candidate('s1', 'native-1', wc)]
      // The command names only the versioned folder, which is clean: nothing to mark yet.
      expect(await tracker.scan(candidates)).toEqual({})
      tracker.observeStatus(wc, [{ absolutePath: join(wc, 'gen', 'out.ts'), nodeKind: 'file' }])
      expect(await tracker.scan(candidates)).toEqual({ s1: { files: 1, sample: ['gen/out.ts'] } })
      await cache.flush()
    } finally { await fsPromises.rm(root, { recursive: true, force: true }) }
  })
})
