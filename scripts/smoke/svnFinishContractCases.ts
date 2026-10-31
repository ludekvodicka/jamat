import assert from 'node:assert/strict'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export class SvnFinishContractCases {
  static readonly cases: readonly (readonly [string, string, string])[] = [
  ['NF33', 'finish/finishDriver', 'partial publication then keep'],
  ['NF34', 'finish/finishDriver', 'partial publication then discard'],
  ['NF35', 'finish/finishDriver', 'corrective publication of only the differing file'],
  ['NF36', 'finish/finishDriver', 'real scripts manager'],
  ["NF31", "finish/finishFlow", "yields a long repository sequence"],
  ["NF32", "finish/syncStep", "same-HEAD Finish refreshes floating externals"],
  [
    "NF01",
    "finish/finishDriver",
    "syncs before review, publishes the approved bytes"
  ],
  [
    "NF02",
    "finish/finishDriver",
    "hands 22 conflicts"
  ],
  [
    "NF03",
    "finish/finishDriver",
    "does not relabel a migrated person-owned dirty action"
  ],
  [
    "NF04",
    "finish/reviewCandidates",
    "binds the second window"
  ],
  [
    "NF05",
    "finish/reviewCandidates",
    "refreshes changed selected evidence"
  ],
  [
    "NF06",
    "finish/verifyStep",
    "verifies native CRLF bytes"
  ],
  [
    "NF07",
    "finish/verifyStep",
    "verifies native CRLF bytes"
  ],
  [
    "NF08",
    "finish/syncStep",
    "queues real gateway input"
  ],
  [
    "NF09",
    "finish/syncStep",
    "worker request returns conflicts"
  ],
  [
    "NF10",
    "finish/finishDriver",
    "recovers an accepted commit after a failed response"
  ],
  [
    "NF11",
    "finish/finishDriver",
    "recovers absent publication evidence"
  ],
  [
    "NF12",
    "worktreeRecovery",
    "passes the saved update target"
  ],
  [
    "NF13",
    "finish/workerLiveness",
    "resumes the interrupted conversation"
  ],
  [
    "NF14",
    "finish/workerLiveness",
    "stops after two failures"
  ],
  [
    "NF15",
    "finish/dispositionStep",
    "disposes proven setup/check changes"
  ],
  [
    "NF16",
    "../hostGate",
    "refuses an old or unreachable Host"
  ],
  [
    "NF17",
    "../launch/svnShim",
    "refuses write aliases"
  ],
  [
    "NF18",
    "finish/finishDriver",
    "publishes two mounts before their owner"
  ],
  [
    "NF19",
    "finish/finishDriver",
    "requires acknowledgements of a proposed message"
  ],
  [
    "NF20",
    "finish/commitStep",
    "stops on the first out-of-date result and requires new preparation"
  ],
  [
    "NF21",
    "finish/finishDriver",
    "reconciles a failed publication before a new approval"
  ],
  [
    "NF22",
    "removal/svnWorktreeRemoval",
    "keeps the worktree whole when a process holds it"
  ],
  [
    "NF23",
    "removal/svnWorktreeRemoval",
    "deletes ignored and discarded content without saving a copy of it"
  ],
  [
    "NF24",
    "removal/svnWorktreeRemoval",
    "allows a personal discard of dirty content"
  ],
  [
    "NF25",
    "landing/mainCopyUpdate",
    "offers UPDATE for verified publication"
  ],
  [
    "NF26",
    "finish/finishDriver",
    "waits without a window"
  ],
  [
    "NF27",
    "finish/finishDriver",
    "reviews a corrective publication explicitly"
  ],
  [
    "NF28",
    "removal/svnWorktreeRemoval",
    "keeps a worktree targeted by a global skill link"
  ],
  [
    "NF29",
    "finish/finishDriver",
    "requires an explicit person override"
  ],
  [
    "NF30",
    "worktreeLifecycleMigration",
    "keeps all 22 conflict memories"
  ]
]
  static async run(selected?: readonly string[], parent = tmpdir()): Promise<void> {
    const cases = this.cases.filter(([id]) => selected === undefined || selected.includes(id))
    if (selected !== undefined) for (const id of selected) assert(this.cases.some(([known]) => known === id), `Unknown NF case: ${id}`)
    if (cases.length === 0) return
    const root = await mkdtemp(join(parent, 'jamat-nf-contract-')), repo = resolve(import.meta.dirname, '..', '..'), report = join(root, 'results.json')
    try {
      const files = [...new Set(cases.map(([, file]) => `worktrees/${file}.test.ts`))]
      const pattern = cases.map(([, , name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      const run = await new CommandInvoker().run({ command: process.execPath,
        args: [join(repo, 'lib-orchestrator/node_modules/vitest/vitest.mjs'), 'run', ...files, '-t', pattern, '--reporter=json', '--outputFile', report],
        cwd: join(repo, 'lib-orchestrator'), env: process.env, timeoutMs: 120_000, retain: 'all' })
      assert.equal(run.failure, null, run.stderr); assert.equal(run.code, 0, run.stdout + run.stderr)
      const result = JSON.parse(await readFile(report, 'utf8')) as { testResults: { assertionResults: { fullName: string; status: string }[] }[] }
      const assertions = result.testResults.flatMap((file) => file.assertionResults)
      for (const [id, , name] of cases) {
        const matched = assertions.filter((row) => row.fullName.includes(name))
        assert(matched.length > 0 && matched.every((row) => row.status === 'passed'), `${id}: missing or failed contract assertion: ${name}`)
        console.log(`  ok  ${id} lifecycle contract: ${name}`)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}
