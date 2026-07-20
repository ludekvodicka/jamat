import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { StatsGenerationProgressUpdate } from '../../../core/types/stats.js'
import { publishTo } from './streams'
import { StatsProgressStreamParser, type StatsProgressStreamItem } from './statsProgressStreamParser'

export interface StatsGenerationContext {
  root: string
  configDir: string
}

export interface StatsGenerationSubscriber {
  requestId?: string
  webContents?: WebContents
}

export interface StatsGenerationResult {
  ok: boolean
  error?: string
}

interface ActiveSubscriber {
  requestId: string
  webContents: WebContents
}

interface ActiveJob {
  key: string
  subscribers: Map<string, ActiveSubscriber>
  latest: StatsGenerationProgressUpdate | null
  promise: Promise<StatsGenerationResult>
}

export class StatsGenerationRunner {
  private static readonly INACTIVITY_TIMEOUT_MS = 120_000
  private static readonly HARD_TIMEOUT_MS = 15 * 60_000
  private static active: ActiveJob | null = null

  static async generateData(context: StatsGenerationContext, subscriber: StatsGenerationSubscriber = {}): Promise<StatsGenerationResult> {
    const key = `${context.root}\0${context.configDir}`
    if (StatsGenerationRunner.active && StatsGenerationRunner.active.key !== key) {
      await StatsGenerationRunner.active.promise
      return StatsGenerationRunner.generateData(context, subscriber)
    }

    let job = StatsGenerationRunner.active
    if (!job) {
      job = {
        key,
        subscribers: new Map(),
        latest: null,
        promise: Promise.resolve({ ok: false, error: 'Stats job did not start' }),
      }
      const current = job
      job.promise = StatsGenerationRunner.runData(context, current).finally(() => {
        if (StatsGenerationRunner.active === current) StatsGenerationRunner.active = null
      })
      StatsGenerationRunner.active = job
    }

    const cleanup = StatsGenerationRunner.subscribe(job, subscriber)
    try {
      return await job.promise
    } finally {
      cleanup()
    }
  }

  private static async runData(context: StatsGenerationContext, job: ActiveJob): Promise<StatsGenerationResult> {
    const script = join(context.root, 'app-stats', 'generate-stats.ts')
    return StatsGenerationRunner.runScript(
      context,
      script,
      (progress) => {
        job.latest = progress
        for (const subscriber of job.subscribers.values())
          StatsGenerationRunner.publish(subscriber, progress)
      },
      StatsGenerationRunner.INACTIVITY_TIMEOUT_MS,
      StatsGenerationRunner.HARD_TIMEOUT_MS,
    )
  }

  private static subscribe(job: ActiveJob, subscriber: StatsGenerationSubscriber): () => void {
    if (!subscriber.requestId || !subscriber.webContents) return () => {}
    const key = `${subscriber.webContents.id}:${subscriber.requestId}`
    const active: ActiveSubscriber = { requestId: subscriber.requestId, webContents: subscriber.webContents }
    const remove = () => job.subscribers.delete(key)
    job.subscribers.set(key, active)
    subscriber.webContents.once('destroyed', remove)
    if (job.latest) StatsGenerationRunner.publish(active, job.latest)
    return () => {
      subscriber.webContents?.removeListener('destroyed', remove)
      job.subscribers.delete(key)
    }
  }

  private static runScript(
    context: StatsGenerationContext,
    script: string,
    onProgress: ((progress: StatsGenerationProgressUpdate) => void) | undefined,
    inactivityTimeoutMs: number,
    hardTimeoutMs: number,
  ): Promise<StatsGenerationResult> {
    const tsxCli = join(context.root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (!existsSync(tsxCli)) return Promise.resolve({ ok: false, error: 'Usage stats needs a source checkout (not available in the installed build yet)' })
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(process.execPath, [tsxCli, script, '--config-dir', context.configDir], {
          cwd: context.root,
          stdio: 'pipe',
          windowsHide: true,
        })
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      let settled = false
      let stderr = ''
      let inactivityTimer: ReturnType<typeof setTimeout>
      const stdout = new StatsProgressStreamParser()

      const finish = (result: StatsGenerationResult) => {
        if (settled) return
        settled = true
        clearTimeout(inactivityTimer)
        clearTimeout(hardTimer)
        resolve(result)
      }
      const timeout = (kind: 'inactivity' | 'hard') => {
        StatsGenerationRunner.terminateTree(child)
        finish({ ok: false, error: kind === 'inactivity' ? `No stats progress for ${Math.round(inactivityTimeoutMs / 1000)} seconds` : `Stats generation exceeded ${Math.round(hardTimeoutMs / 60_000)} minutes` })
      }
      const resetInactivity = () => {
        clearTimeout(inactivityTimer)
        inactivityTimer = setTimeout(() => timeout('inactivity'), inactivityTimeoutMs)
      }
      const processItems = (items: StatsProgressStreamItem[]) => {
        for (const item of items) {
          if (item.kind === 'progress') onProgress?.(item.progress)
          else if (item.kind === 'diagnostic') {
            if (item.line.trim()) console.log(`[stats] ${item.line}`)
          } else
            throw new Error(`Unknown stats stdout item: ${JSON.stringify(item)}`)
        }
      }
      const processStdout = (chunk: Buffer) => {
        resetInactivity()
        processItems(stdout.push(chunk))
      }
      const hardTimer = setTimeout(() => timeout('hard'), hardTimeoutMs)
      resetInactivity()
      child.stdout?.on('data', processStdout)
      child.stderr?.on('data', (chunk: Buffer) => {
        resetInactivity()
        stderr = `${stderr}${chunk.toString()}`.slice(-4000)
      })
      child.once('error', (error) => finish({ ok: false, error: error.message }))
      child.once('close', (code) => {
        processItems(stdout.finish())
        finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `Stats process exited with code ${code}` })
      })
    })
  }

  private static publish(subscriber: StatsGenerationSubscriber, progress: StatsGenerationProgressUpdate): void {
    if (!subscriber.requestId || !subscriber.webContents) return
    publishTo(subscriber.webContents, 'stats:progress', { ...progress, requestId: subscriber.requestId })
  }

  private static terminateTree(child: ChildProcess): void {
    if (!child.pid) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else if (process.platform === 'linux') child.kill('SIGKILL')
    else if (process.platform === 'darwin') child.kill('SIGKILL')
    else
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
