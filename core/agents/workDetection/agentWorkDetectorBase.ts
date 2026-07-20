import type { AgentId } from '../../types/contracts.js'
import type {
  AgentWorkDetectorCallbacks,
  AgentWorkDetectorScheduler,
  AgentWorkFrame,
  AgentWorkHint,
  AgentWorkInspection,
  AgentWorkInspectionMode,
  AgentWorkReport,
  AgentWorkStatus,
  AgentWorkTimer,
  AgentWorkVerdict,
} from './agentWorkDetector.types.js'

export abstract class AgentWorkDetectorBase {
  abstract readonly agent: AgentId

  private static readonly FAST_IDLE_MS = 1200
  private static readonly SILENCE_MS = 15000
  private static readonly TOOL_EXPIRY_MS = 3000
  private static readonly DONE_MS = 3000
  private static readonly ANSI_PATTERN = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g

  private readonly callbacks: AgentWorkDetectorCallbacks
  private readonly scheduler: AgentWorkDetectorScheduler
  private status: AgentWorkStatus = 'idle'
  private backgroundActivity = false
  private latestFrame: AgentWorkFrame | null = null
  private silenceTimer: AgentWorkTimer | null = null
  private fastIdleTimer: AgentWorkTimer | null = null
  private toolExpiryTimer: AgentWorkTimer | null = null
  private doneTimer: AgentWorkTimer | null = null
  private disposed = false

  constructor(callbacks: AgentWorkDetectorCallbacks, scheduler?: AgentWorkDetectorScheduler) {
    this.callbacks = callbacks
    this.scheduler = scheduler ?? AgentWorkDetectorBase.createScheduler()
  }

  get currentStatus(): AgentWorkStatus { return this.status }

  static stripAnsiLower(text: string): string {
    return text.replace(AgentWorkDetectorBase.ANSI_PATTERN, '').toLowerCase()
  }

  static normalizeTty(text: string): string {
    return AgentWorkDetectorBase.stripAnsiLower(text).replace(/\s+/g, '')
  }

  static isActiveStatus(status: AgentWorkStatus): boolean {
    if (status === 'idle') return false
    else if (status === 'running') return true
    else if (status === 'tool-use') return true
    else if (status === 'blocked') return true
    else if (status === 'waiting') return true
    else if (status === 'done') return false
    else
      throw new Error(`Unknown agent work status: ${JSON.stringify(status)}`)
  }

  onOutput(frame: AgentWorkFrame): void {
    this.processFrame(frame, 'output', true)
  }

  onRenderedFrame(frame: AgentWorkFrame): void {
    this.processFrame(frame, 'rendered', false)
  }

  reset(): void {
    if (this.disposed) return
    this.cancelTimers()
    this.latestFrame = null
    this.setBackgroundActivity(false)
    this.setStatus('idle')
    this.callbacks.onIdle()
    this.publish(AgentWorkDetectorBase.unknownInspection(false), 'reset', 'idle')
  }

  onProcessExit(): void {
    if (this.disposed) return
    this.cancelTimers()
    this.setBackgroundActivity(false)
    this.setStatus('done')
    this.publish(AgentWorkDetectorBase.unknownInspection(false), 'process-exit', 'idle')
    this.doneTimer = this.scheduler.setTimeout(() => {
      this.doneTimer = null
      if (this.disposed) return
      this.setStatus('idle')
      this.callbacks.onIdle()
      this.publish(AgentWorkDetectorBase.unknownInspection(false), 'process-exit', 'idle')
    }, AgentWorkDetectorBase.DONE_MS)
  }

  dispose(): void {
    if (this.disposed) return
    this.cancelTimers()
    this.disposed = true
  }

  protected abstract inspect(frame: AgentWorkFrame, mode: AgentWorkInspectionMode): AgentWorkInspection

  private processFrame(frame: AgentWorkFrame, mode: AgentWorkInspectionMode, scheduleSilence: boolean): void {
    if (this.disposed) return
    this.latestFrame = frame
    if (frame.phase === 'menu') {
      this.reset()
      return
    } else if (frame.phase !== 'running')
      throw new Error(`Unknown terminal phase: ${JSON.stringify(frame.phase)}`)

    const inspection = this.inspect(frame, mode)
    this.setBackgroundActivity(inspection.backgroundActivity)
    this.applyInspection(inspection)
    this.updateFastIdle(inspection)
    if (scheduleSilence) this.scheduleSilence()
    this.publish(inspection, 'evidence')
  }

  private applyInspection(inspection: AgentWorkInspection): void {
    if (inspection.hint === 'working') this.setStatus('running')
    else if (inspection.hint === 'tool-use') {
      this.setStatus('tool-use')
      this.scheduleToolExpiry()
    } else if (inspection.hint === 'blocked') this.setStatus('blocked')
    else if (inspection.hint === 'waiting') this.setStatus('waiting')
    else if (inspection.hint === 'idle') return
    else if (inspection.hint === 'unknown') return
    else
      throw new Error(`Unknown work hint: ${JSON.stringify(inspection.hint)}`)
  }

  private updateFastIdle(inspection: AgentWorkInspection): void {
    if (inspection.hint === 'idle' && this.status !== 'idle') {
      if (!this.fastIdleTimer)
        this.fastIdleTimer = this.scheduler.setTimeout(() => {
          this.fastIdleTimer = null
          this.settle('fast-idle')
        }, AgentWorkDetectorBase.FAST_IDLE_MS)
      return
    }
    this.clearFastIdle()
  }

  private scheduleSilence(): void {
    this.clearSilence()
    this.silenceTimer = this.scheduler.setTimeout(() => {
      this.silenceTimer = null
      this.settle('silence')
    }, AgentWorkDetectorBase.SILENCE_MS)
  }

  private scheduleToolExpiry(): void {
    if (this.toolExpiryTimer) this.scheduler.clearTimeout(this.toolExpiryTimer)
    this.toolExpiryTimer = this.scheduler.setTimeout(() => {
      this.toolExpiryTimer = null
      if (this.disposed || this.status !== 'tool-use') return
      this.setStatus('running')
      this.publish({ hint: 'working', evidence: [], backgroundActivity: this.backgroundActivity }, 'tool-expiry')
    }, AgentWorkDetectorBase.TOOL_EXPIRY_MS)
  }

  private settle(reason: 'fast-idle' | 'silence'): void {
    if (this.disposed) return
    const frame = this.readFrame()
    this.latestFrame = frame
    if (frame.phase === 'menu') {
      this.reset()
      return
    } else if (frame.phase !== 'running')
      throw new Error(`Unknown terminal phase: ${JSON.stringify(frame.phase)}`)

    const inspection = this.inspect(frame, 'settled')
    this.setBackgroundActivity(inspection.backgroundActivity)
    if (inspection.hint === 'working' || inspection.hint === 'tool-use' || inspection.hint === 'blocked' || inspection.hint === 'waiting') {
      this.applyInspection(inspection)
      this.publish(inspection, reason)
      return
    } else if (inspection.hint === 'idle') {
      this.confirmIdle(inspection, reason)
      return
    } else if (inspection.hint === 'unknown') {
      if (reason === 'silence') this.confirmIdle(inspection, reason)
      else this.publish(inspection, reason)
      return
    } else
      throw new Error(`Unknown work hint: ${JSON.stringify(inspection.hint)}`)
  }

  private confirmIdle(inspection: AgentWorkInspection, reason: 'fast-idle' | 'silence'): void {
    this.clearSilence()
    this.clearFastIdle()
    if (this.toolExpiryTimer) {
      this.scheduler.clearTimeout(this.toolExpiryTimer)
      this.toolExpiryTimer = null
    }
    this.setStatus('idle')
    this.callbacks.onIdle()
    this.publish(inspection, reason, 'idle')
  }

  private setStatus(status: AgentWorkStatus): void {
    if (this.status === status) return
    this.status = status
    if (status !== 'tool-use' && this.toolExpiryTimer) {
      this.scheduler.clearTimeout(this.toolExpiryTimer)
      this.toolExpiryTimer = null
    }
    this.callbacks.onStatus(status)
  }

  private setBackgroundActivity(active: boolean): void {
    if (this.backgroundActivity === active) return
    this.backgroundActivity = active
    this.callbacks.onBackgroundActivity(active)
  }

  private publish(inspection: AgentWorkInspection, reason: AgentWorkReport['reason'], verdict?: AgentWorkVerdict): void {
    const frame = this.latestFrame ?? this.readFrame()
    const report: AgentWorkReport = {
      agent: this.agent,
      status: this.status,
      active: AgentWorkDetectorBase.isActiveStatus(this.status),
      verdict: verdict ?? AgentWorkDetectorBase.verdictFor(inspection.hint),
      reason,
      evidence: inspection.evidence,
      backgroundActivity: this.backgroundActivity,
      timestamp: this.scheduler.now(),
    }
    this.callbacks.onReport(report, frame)
  }

  private readFrame(): AgentWorkFrame {
    try { return this.callbacks.readFrame() }
    catch {
      return { rawTail: '', screenTail: '', wideScreenTail: '', phase: 'running', timestamp: this.scheduler.now() }
    }
  }

  private clearFastIdle(): void {
    if (!this.fastIdleTimer) return
    this.scheduler.clearTimeout(this.fastIdleTimer)
    this.fastIdleTimer = null
  }

  private clearSilence(): void {
    if (!this.silenceTimer) return
    this.scheduler.clearTimeout(this.silenceTimer)
    this.silenceTimer = null
  }

  private cancelTimers(): void {
    this.clearFastIdle()
    this.clearSilence()
    if (this.toolExpiryTimer) this.scheduler.clearTimeout(this.toolExpiryTimer)
    if (this.doneTimer) this.scheduler.clearTimeout(this.doneTimer)
    this.toolExpiryTimer = null
    this.doneTimer = null
  }

  private static verdictFor(hint: AgentWorkHint): AgentWorkVerdict {
    if (hint === 'working') return 'working'
    else if (hint === 'tool-use') return 'working'
    else if (hint === 'blocked') return 'working'
    else if (hint === 'waiting') return 'working'
    else if (hint === 'idle') return 'idle'
    else if (hint === 'unknown') return 'unknown'
    else
      throw new Error(`Unknown work hint: ${JSON.stringify(hint)}`)
  }

  private static unknownInspection(backgroundActivity: boolean): AgentWorkInspection {
    return { hint: 'unknown', evidence: [], backgroundActivity }
  }

  private static createScheduler(): AgentWorkDetectorScheduler {
    return {
      now: () => Date.now(),
      setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    }
  }
}
