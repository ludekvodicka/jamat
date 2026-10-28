import { appendFileSync } from 'node:fs'
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeUsageParser } from './claudeUsageParser'
import { CodexUsageParser } from './codexUsageParser'
import { TokenUsageScanner } from './tokenUsageScanner'

describe('TokenUsageScanner', () => {
  let root: string, file: string
  const at = new Date(2026, 9, 26, 9).getTime()
  const line = (id: string, input = 10, time = at, cwd = 'project') => JSON.stringify({ type: 'assistant', sessionId: 'native', cwd,
    timestamp: new Date(time).toISOString(), requestId: 'request', message: { id, model: 'opus', usage: { input_tokens: input } } }) + '\n'
  beforeEach(async () => {
    const parent = join(import.meta.dirname, '../../.aidocs/temp')
    await mkdir(parent, { recursive: true })
    root = await mkdtemp(join(parent, 'token-usage-test-'))
    await mkdir(join(root, 'projects/a'), { recursive: true })
    file = join(root, 'projects/a/native.jsonl')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const scanner = (sources = [ClaudeUsageParser.source(root)]) => new TokenUsageScanner({ sources, cacheFile: join(root, 'cache.json'),
    resolveAccount: () => 'main', resolveProject: cwd => cwd })
  const total = (buckets: Awaited<ReturnType<TokenUsageScanner['scan']>>) => buckets.reduce((sum, bucket) => sum + bucket.input, 0)

  it('globally deduplicates message/request identities across files, appends once and survives restart', async () => {
    await writeFile(file, line('one'))
    await writeFile(join(root, 'projects/a/copy.jsonl'), line('one', 999, at + 1))
    const first = scanner()
    expect(total(await first.scan())).toBe(10)
    await appendFile(file, line('two'))
    expect(total(await first.scan())).toBe(20)
    expect(total(await scanner().scan())).toBe(20)
    const persisted = JSON.parse(await readFile(join(root, 'cache.json'), 'utf8'))
    expect(persisted.buckets[0].input).toBe(20)
  })
  it('replaces file contributions after truncation and backward mtime, including stale dedup identities', async () => {
    await writeFile(file, line('one') + line('two'))
    const first = scanner()
    expect(total(await first.scan())).toBe(20)
    await writeFile(file, line('one', 3))
    expect(total(await first.scan())).toBe(3)
    await writeFile(file, line('new', 8))
    await utimes(file, new Date(0), new Date(0))
    expect(total(await scanner().scan())).toBe(8)
  })
  it('carries an unfinished UTF-8 line across a restart without counting it early', async () => {
    const bytes = Buffer.from(line('one', 10, at, 'Žlutý'))
    const split = bytes.indexOf(Buffer.from('Ž')) + 1
    await writeFile(file, bytes.subarray(0, split))
    expect(await scanner().scan()).toEqual([])
    await appendFile(file, bytes.subarray(split))
    expect(await scanner().scan()).toMatchObject([{ projectKey: 'Žlutý', input: 10, hour: 9, day: '2026-10-26' }])
  })
  it('reads linked profile directories and hard-linked files only once', async () => {
    await writeFile(file, line('one').replace('"id":"one",', ''))
    await link(file, join(root, 'projects/a/hard.jsonl'))
    await symlink(join(root, 'projects/a'), join(root, 'projects/alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(total(await scanner().scan())).toBe(10)
  })
  it('reads at most the stat-sized prefix when a transcript grows mid-scan', async () => {
    await writeFile(file, line('one'))
    const source = ClaudeUsageParser.source(root), parse = source.parse
    let appended = false
    source.parse = (line, state) => {
      if (!appended) { appended = true; appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { usage: { input_tokens: 50 } } }) + '\n') }
      return parse(line, state)
    }
    const first = scanner([source])
    expect(total(await first.scan())).toBe(10)
    expect(total(await first.scan())).toBe(60)
  })
  it('keeps Codex cumulative counters after restart', async () => {
    await mkdir(join(root, 'sessions'))
    const rollout = join(root, 'sessions/rollout-x.jsonl')
    const line = (input: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: 5 } } } }) + '\n'
    await writeFile(rollout, line(100))
    expect(total(await scanner([CodexUsageParser.source(root)]).scan())).toBe(50)
    await appendFile(rollout, line(100) + line(200))
    expect(total(await scanner([CodexUsageParser.source(root)]).scan())).toBe(100)
  })
  it('rebuilds schema-1 skipped Codex records atomically on ordinary refresh and reuses the repaired cache', async () => {
    await mkdir(join(root, 'sessions'))
    const rollout = join(root, 'sessions/rollout-old.jsonl'), cacheFile = join(root, 'cache.json')
    const event = (info: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', info } }) + '\n'
    await writeFile(rollout, event({ total_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20 } })
      + event({ last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3 } }))
    const resolved = await realpath(rollout), metadata = await stat(rollout)
    const old = JSON.stringify({ schema: 1, files: { [resolved]: {
      file: resolved, agentId: 'codex', size: metadata.size, mtimeMs: metadata.mtimeMs,
      identity: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`, offset: metadata.size, carry: '',
      parser: { nativeId: 'rollout-old', cwd: '', model: 'unknown', rolloutAccount: null, cumulative: { input: 100, output: 20, cached: 30 } },
      records: [{ at, nativeId: 'rollout-old', cwd: '', model: 'unknown', rolloutAccount: null, dedupe: null,
        input: 70, output: 20, cacheRead: 30, cacheWrite: 0 }],
    } }, buckets: [{ day: '2026-10-26', hour: 9, projectKey: '', agentId: 'codex', accountId: 'main', model: 'unknown',
      input: 70, output: 20, cacheRead: 30, cacheWrite: 0 }] })
    await writeFile(cacheFile, old)
    const source = CodexUsageParser.source(root), parse = source.parse, refreshed = scanner([source])
    source.parse = () => { throw new Error('fixture migration read failure') }
    await expect(refreshed.scan()).rejects.toThrow('fixture migration read failure')
    expect(await readFile(cacheFile, 'utf8')).toBe(old)
    source.parse = parse
    expect(await refreshed.scan()).toMatchObject([{ input: 85, output: 23, cacheRead: 35, cacheWrite: 0 }])
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ schema: 2,
      files: { [resolved]: { offset: metadata.size, records: [{ input: 70 }, { input: 15 }] } } })
    source.parse = () => { throw new Error('Repaired unchanged transcript must not be reparsed') }
    expect(await refreshed.scan()).toMatchObject([{ input: 85, output: 23, cacheRead: 35 }])
    expect(await scanner([source]).scan()).toMatchObject([{ input: 85, output: 23, cacheRead: 35 }])
    source.parse = parse
    await appendFile(rollout, event({ total_token_usage: { input_tokens: 150, cached_input_tokens: 45, output_tokens: 30 } }))
    expect(await scanner([source]).scan()).toMatchObject([{ input: 120, output: 33, cacheRead: 50 }])
  })
  it('keeps the previous cursor and partial line when a parse pass fails, then rebuilds malformed cache', async () => {
    const bytes = line('one')
    await writeFile(file, bytes.slice(0, 20))
    const source = ClaudeUsageParser.source(root), parse = source.parse
    const first = scanner([source])
    expect(await first.scan()).toEqual([])
    await appendFile(file, bytes.slice(20))
    source.parse = () => { throw new Error('fixture read failure') }
    await expect(first.scan()).rejects.toThrow('fixture read failure')
    source.parse = parse
    expect(total(await first.scan())).toBe(10)
    await writeFile(join(root, 'cache.json'), JSON.stringify({ schema: 1, files: { [file]: { offset: 999 } }, buckets: [] }))
    expect(total(await scanner().scan())).toBe(10)
  })
  it('attributes Claude segment spans and registered versus unknown Codex identities', async () => {
    const claude = ClaudeUsageParser.accountResolver([{ agentId: 'claude', nativeSessionId: 'native', cwd: 'project', ownerPath: null,
      accountSegments: [{ accountId: 'work', from: at, to: at + 100 }] }])
    const codex = CodexUsageParser.accountResolver([
      { agentId: 'codex', accountId: 'work-codex', label: 'Work', identity: { key: 'identity', label: 'Identity' }, isMain: false, state: 'active', profileProblem: null },
    ])
    expect(claude('native', at + 1, null)).toBe('work')
    expect(claude('native', at + 100, null)).toBe('main')
    expect(codex('native', at, 'identity')).toBe('work-codex')
    expect(codex('native', at, 'unknown')).toBe('other-codex-account')
    expect(codex('native', at, null)).toBe('main')
    await writeFile(file, line('inside', 7, at + 1) + line('outside', 3, at + 100))
    const attributed = new TokenUsageScanner({ sources: [ClaudeUsageParser.source(root)], cacheFile: join(root, 'attributed.json'),
      resolveAccount: (_agent, ...args) => claude(...args), resolveProject: cwd => cwd })
    expect((await attributed.scan()).map(bucket => [bucket.accountId, bucket.input])).toEqual([['work', 7], ['main', 3]])
  })
})
