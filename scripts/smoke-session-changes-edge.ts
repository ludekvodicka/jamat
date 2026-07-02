// Edge-case verification for extractSessionTurns.
// Runs against synthetic JSONL inputs (no real corpus needed).

import { extractSessionTurns, extractSessionHasEdits, _resetSessionTurnsCacheForTests } from '../core/agents/claude/session-changes.js'
import { composeFileNetDiff, locateRegionStartLine } from '../core/menu-core/diff-compose.js'
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'session-changes-test-'))

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${msg}`)
  }
}

// --- Scenario: empty file
{
  const p = join(tmp, 'empty.jsonl')
  writeFileSync(p, '')
  assert(extractSessionTurns(p).length === 0, 'empty JSONL → 0 turns')
}

// --- Scenario: malformed last line (partial)
{
  const p = join(tmp, 'partial.jsonl')
  writeFileSync(
    p,
    JSON.stringify({ type: 'user', message: { content: 'hello world' } }) +
      '\n' +
      '{"type":"assistant","mess', // truncated
  )
  const t = extractSessionTurns(p)
  assert(t.length === 1, 'partial last line → 1 turn (no crash)')
  assert(t[0].userPromptText === 'hello world', 'partial last line → user text preserved')
}

// --- Scenario: tool_result continuation messages do NOT start new turns
{
  const p = join(tmp, 'tool-result.jsonl')
  const lines = [
    { type: 'user', message: { content: 'do the thing' } },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/a/foo.ts', old_string: 'A', new_string: 'B' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/a/foo.ts', old_string: 'C', new_string: 'D' },
          },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const t = extractSessionTurns(p)
  assert(t.length === 1, 'tool_result continuation does not start new turn')
  assert(t[0].files.length === 1, 'two edits to same file → 1 file entry')
  assert(t[0].files[0].editCount === 2, 'two edits composed → editCount=2')
}

// --- Scenario: 3 sequential edits to same file in one turn
{
  const p = join(tmp, 'three-edits.jsonl')
  const lines = [
    { type: 'user', message: { content: 'refactor it' } },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/a/x.ts', old_string: 'foo', new_string: 'bar' },
          },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/a/x.ts', old_string: 'bar', new_string: 'baz' },
          },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/a/x.ts', old_string: 'baz', new_string: 'qux' },
          },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const t = extractSessionTurns(p)
  assert(t.length === 1, 'three-edits: one turn')
  assert(t[0].files[0].editCount === 3, 'three-edits: editCount=3')
  assert(t[0].files[0].beforeText === 'foo', `three-edits: before='foo' (got '${t[0].files[0].beforeText}')`)
  assert(t[0].files[0].afterText === 'qux', `three-edits: after='qux' (got '${t[0].files[0].afterText}')`)
}

// --- Scenario: Write to new file
{
  const p = join(tmp, 'new-file.jsonl')
  const lines = [
    { type: 'user', message: { content: 'create file' } },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/a/new.md', content: 'hello' },
          },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const t = extractSessionTurns(p)
  assert(t[0].files[0].isNewFile === true, 'Write of fresh file → isNewFile=true')
  assert(t[0].files[0].isOverwritten === false, 'Write of fresh file → isOverwritten=false')
  assert(t[0].files[0].beforeText === '', 'Write of fresh file → before=""')
  assert(t[0].files[0].afterText === 'hello', 'Write of fresh file → after=content')
}

// --- Scenario: Write to file that earlier turn already wrote → overwritten
{
  const p = join(tmp, 'overwrite.jsonl')
  const lines = [
    { type: 'user', message: { content: 'first' } },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/a/x.md', content: 'v1' },
          },
        ],
      },
    },
    { type: 'user', message: { content: 'second' } },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/a/x.md', content: 'v2' },
          },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const t = extractSessionTurns(p)
  assert(t.length === 2, 'overwrite: 2 turns')
  assert(t[0].files[0].isNewFile === true, 'overwrite: turn 0 file is new')
  assert(t[1].files[0].isOverwritten === true, 'overwrite: turn 1 file is overwritten')
  assert(t[1].files[0].isNewFile === false, 'overwrite: turn 1 file not new')
}

// --- Scenario: cache invalidation on mtime/size change
{
  const p = join(tmp, 'cache.jsonl')
  _resetSessionTurnsCacheForTests()
  writeFileSync(
    p,
    JSON.stringify({ type: 'user', message: { content: 'first turn' } }) + '\n',
  )
  const t1 = extractSessionTurns(p)
  assert(t1.length === 1, 'cache: first read → 1 turn')

  // Append a second user message — both mtime and size change.
  appendFileSync(p, JSON.stringify({ type: 'user', message: { content: 'second turn' } }) + '\n')
  // bump mtime explicitly to ensure change is detected even on systems with
  // coarse mtime granularity
  const future = new Date(Date.now() + 5000)
  utimesSync(p, future, future)

  const t2 = extractSessionTurns(p)
  assert(t2.length === 2, `cache: after append → 2 turns (got ${t2.length})`)
  assert(t2 !== t1, 'cache: returned new array, not cached one')
}

// --- Scenario: composeFileNetDiff — file edited across multiple turns
{
  const p = join(tmp, 'net-multi-turn.jsonl')
  const lines = [
    { type: 'user', message: { content: 'turn one' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/n.ts', old_string: 'foo', new_string: 'bar' } },
        ],
      },
    },
    { type: 'user', message: { content: 'turn two' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/n.ts', old_string: 'bar', new_string: 'baz' } },
        ],
      },
    },
    { type: 'user', message: { content: 'turn three' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/n.ts', old_string: 'baz', new_string: 'qux' } },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const turns = extractSessionTurns(p)
  const net = composeFileNetDiff(turns, '/a/n.ts')
  assert(net !== null, 'net diff: file found across turns')
  assert(net?.beforeText === 'foo', `net diff: before='foo' (got '${net?.beforeText}')`)
  assert(net?.afterText === 'qux', `net diff: after='qux' (got '${net?.afterText}')`)
  assert(net?.editCount === 3, `net diff: editCount=3 (got ${net?.editCount})`)
  assert(net?.turnCount === 3, `net diff: turnCount=3 (got ${net?.turnCount})`)
}

// --- Scenario: composeFileNetDiff — Write then Edit is NOT claimed as a
// "new file" (a leading Write may be an overwrite of pre-existing content,
// which the transcript cannot disprove).
{
  const p = join(tmp, 'net-create-edit.jsonl')
  const lines = [
    { type: 'user', message: { content: 'create' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/a/c.ts', content: 'line1\nline2' } },
        ],
      },
    },
    { type: 'user', message: { content: 'tweak' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/c.ts', old_string: 'line2', new_string: 'LINE2' } },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const turns = extractSessionTurns(p)
  const net = composeFileNetDiff(turns, '/a/c.ts')
  assert(net?.isNewFile === false, 'net diff: Write-then-Edit → isNewFile=false (not provably a create)')
  assert(net?.beforeText === '', 'net diff: leading Write → before=""')
}

// --- Scenario: composeFileNetDiff — disjoint edits flagged
{
  const p = join(tmp, 'net-disjoint.jsonl')
  const lines = [
    { type: 'user', message: { content: 'edit region A' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/d.ts', old_string: 'alpha', new_string: 'ALPHA' } },
        ],
      },
    },
    { type: 'user', message: { content: 'edit region B' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a/d.ts', old_string: 'omega', new_string: 'OMEGA' } },
        ],
      },
    },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'))
  const turns = extractSessionTurns(p)
  const net = composeFileNetDiff(turns, '/a/d.ts')
  assert(net?.disjoint === true, 'net diff: two disjoint edits → disjoint=true')
}

// --- Scenario: composeFileNetDiff — file never edited → null
{
  const p = join(tmp, 'net-absent.jsonl')
  writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'nothing' } }))
  const turns = extractSessionTurns(p)
  assert(composeFileNetDiff(turns, '/a/missing.ts') === null, 'net diff: absent file → null')
}

// --- Scenario: extractSessionHasEdits
{
  const empty = join(tmp, 'has-edits-none.jsonl')
  writeFileSync(
    empty,
    [
      { type: 'user', message: { content: 'just chat' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  )
  assert(extractSessionHasEdits(empty) === false, 'hasEdits: conversation-only session → false')

  const withEdit = join(tmp, 'has-edits-some.jsonl')
  writeFileSync(
    withEdit,
    [
      { type: 'user', message: { content: 'change it' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  )
  assert(extractSessionHasEdits(withEdit) === true, 'hasEdits: session with one Edit → true')

  assert(extractSessionHasEdits(join(tmp, 'no-such-file.jsonl')) === false, 'hasEdits: missing file → false')

  // Edge case: tool_use appears before any real user prompt (sidechain /
  // replay). The panel ignores these too, so hasEdits must agree.
  const beforeUser = join(tmp, 'has-edits-before-user.jsonl')
  writeFileSync(
    beforeUser,
    [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } },
          ],
        },
      },
      { type: 'user', message: { content: 'now we start' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  )
  assert(
    extractSessionHasEdits(beforeUser) === false,
    'hasEdits: tool_use before first user prompt → false (matches extractSessionTurns)',
  )
}

// --- Scenario: locateRegionStartLine
{
  const fileContent = 'aaa\nbbb\nccc\nddd\neee\nfff'
  assert(locateRegionStartLine(fileContent, 'ccc\nddd\neee') === 3, 'locate: region found → 1-based line 3')
  assert(locateRegionStartLine(fileContent, 'not\nin\nfile') === null, 'locate: region absent → null')
  assert(locateRegionStartLine('xx\nxx\nxx', 'xx') === null, 'locate: ambiguous (multi-match) → null')
  assert(locateRegionStartLine('', 'ccc') === null, 'locate: empty file → null')
  assert(locateRegionStartLine(fileContent, '') === null, 'locate: empty region → null')
}

rmSync(tmp, { recursive: true, force: true })

if (!process.exitCode) console.log('\nAll edge-case assertions passed.')
