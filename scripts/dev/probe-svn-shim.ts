import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker'
import { LaunchPlanner } from '../../lib-orchestrator/sessionManager/launch/launchPlanner'
import { RunTools } from '../../lib-orchestrator/sessionManager/launch/runTools'

async function run(): Promise<void> {
  const invoker = new CommandInvoker()
  const root = mkdtempSync(join(tmpdir(), 'jamat-svn-shim-probe-'))
  const owner = join(root, 'owner')
  const worktree = join(owner, '.worktrees', 'probe')
  const repository = join(root, 'repository')
  const tools = new RunTools({ applicationRoot: resolve('.'), resourcesRoot: null, environment: process.env })
  const svn = tools.resolve('svn')
  try {
    if (!svn.ok) throw new Error(svn.detail)
    mkdirSync(join(owner, '.worktrees'), { recursive: true })
    for (const [command, args] of [['svnadmin', ['create', repository]], [svn.command, ['checkout', pathToFileURL(repository).href, worktree]]] as const) {
      const result = await invoker.run({ command, args: [...args], cwd: root, env: process.env, timeoutMs: 30_000 })
      if (result.code !== 0 || result.failure !== null) throw new Error(result.stderr || `${command} failed`)
    }
    const prompt = 'Run svn status and then svn --non-interactive commit -m probe using the svn command on PATH. Do not bypass the PATH shim. Report the exact refusal and exit code. Do not change any files.'
    for (const agentId of ['claude', 'codex'] as const) {
      const launch = LaunchPlanner.plan({ sessionId: `probe-${agentId}`, kind: 'agent', title: 'SVN shim probe',
        directory: { mode: 'adHoc', path: worktree }, life: 'starting', binding: null, createdAt: Date.now(),
        agent: { agentId, nativeSessionId: 'probe', launchMode: 'new' },
        worktree: { kind: 'svn', repositoryRoot: owner, worktreePath: worktree, baseCommit: 'r0', branch: pathToFileURL(repository).href } }, {
        tools, localStateDir: join(root, 'state'), yolo: true,
        agentArgs: agentId === 'claude' ? ['-p', prompt] : ['exec', '--skip-git-repo-check', prompt],
      })
      const result = await invoker.run({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, timeoutMs: 120_000 })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      console.log(JSON.stringify({ agentId, refused: output.includes('is refused in a Jamat worktree'), exitCode: result.code, failure: result.failure, output }))
      if (!output.includes('is refused in a Jamat worktree')) process.exitCode = 1
    }
  } finally { rmSync(root, { recursive: true, force: true }) }

}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
