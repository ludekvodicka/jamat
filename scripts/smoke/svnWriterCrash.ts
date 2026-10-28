import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { WorktreeLease } from '../../lib-orchestrator/worktrees/worktreeLease.js'

export class SvnWriterCrash {
  private static alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
  private static async until(check: () => Promise<boolean>, reason: string): Promise<void> {
    const end = Date.now() + 15000
    while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error(reason)
  }
  static async run(parent = tmpdir()): Promise<void> {
    const root = await mkdtemp(join(parent, 'jamat-svn-writer-crash-')), repository = join(root, 'repo'), working = join(root, 'working')
    const run = async (command: string, cwd: string, args: string[]) => {
      const result = await new CommandInvoker().run({ command, cwd, args, env: process.env, timeoutMs: 20000 })
      assert.equal(result.code, 0, result.stderr); return result.stdout
    }
    let owner: ReturnType<typeof spawn> | undefined, writer = 0
    try {
      await run('svnadmin', root, ['create', repository])
      await run('svn', root, ['checkout', pathToFileURL(repository).href, working])
      await writeFile(join(working, 'a.txt'), 'one')
      await run('svn', working, ['add', 'a.txt'])
      const message = join(root, 'message.txt'); await writeFile(message, '[Crash] Disposable publication')
      const hook = join(repository, 'hooks', 'wait.cjs')
      await writeFile(hook, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, 'hook-started'))},String(process.pid));const end=Date.now()+20000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'release'))}))clearInterval(t);else if(Date.now()>end)process.exit(1)},100)`)
      if (process.platform === 'win32') await writeFile(join(repository, 'hooks', 'pre-commit.bat'), `@"${process.execPath}" "${hook}"\r\n`)
      else { const file = join(repository, 'hooks', 'pre-commit'); await writeFile(file, `#!/bin/sh\n"${process.execPath}" "${hook}"\n`); await chmod(file, 0o755) }
      owner = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, '--writer-child', working, message, join(root, 'writer-pid')],
        { cwd: join(import.meta.dirname, '..', '..'), windowsHide: true, stdio: 'ignore' })
      await this.until(async () => readFile(join(root, 'hook-started')).then(() => true, () => false), 'Disposable SVN pre-commit hook did not start')
      writer = Number(await readFile(join(root, 'writer-pid'), 'utf8'))
      assert(this.alive(writer), 'Actual SVN writer must be alive before client death')
      owner.kill()
      await this.until(async () => owner!.exitCode !== null || owner!.signalCode !== null, 'Disposable client did not exit')
      const orphanAlive = this.alive(writer)
      await assert.rejects(new WorktreeLease('contender', () => []).take(working, 'update'), /termination is unproved/)
      await writeFile(join(root, 'release'), 'release')
      await this.until(async () => !this.alive(writer), 'Disposable SVN writer did not exit')
      await assert.rejects(new WorktreeLease('later', () => []).take(working, 'update'), /termination is unproved/)
      if (orphanAlive) assert((await run('svn', working, ['log', '--xml', '-r', 'HEAD'])).includes('Disposable publication'))
      console.log(`  ok  NF12 client death retains an unproved writer marker and refuses takeover (orphan observed alive: ${orphanAlive})`)
    } finally {
      if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) owner.kill()
      if (writer && this.alive(writer)) {
        if (process.platform === 'win32') await run('taskkill', root, ['/T', '/F', '/PID', String(writer)])
        else process.kill(writer, 'SIGKILL')
        await this.until(async () => !this.alive(writer), 'Owned writer cleanup failed')
      }
      const hookPid = Number(await readFile(join(root, 'hook-started'), 'utf8').catch(() => '0'))
      if (hookPid && this.alive(hookPid)) { process.kill(hookPid); await this.until(async () => !this.alive(hookPid), 'Owned hook cleanup failed') }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  static async child(working: string, message: string, pidFile: string): Promise<void> {
    const lease = new WorktreeLease('disposable-client', () => [])
    await lease.within(working, 'commit', () => lease.writer(working, async (closed) => {
      const svn = spawn('svn', ['commit', '--non-interactive', '--file', message, '--username', 'fixture'], { cwd: working, windowsHide: true, stdio: 'ignore' })
      await writeFile(pidFile, String(svn.pid))
      await new Promise<void>((resolve, reject) => { svn.once('error', reject); svn.once('close', (code) => { closed(); code === 0 ? resolve() : reject(new Error(`svn ${code}`)) }) })
    }))
  }
}
if (process.argv[2] === '--writer-child') void SvnWriterCrash.child(process.argv[3], process.argv[4], process.argv[5]).catch((error) => { console.error(error); process.exitCode = 1 })
else if (process.argv[2] === '--standalone') void SvnWriterCrash.run().catch((error) => { console.error(error); process.exitCode = 1 })
