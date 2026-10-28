import type { AgentCliUpdateRow, AgentCliUpdatesSnapshot } from './agentCliUpdatesApi.types'
import type { AgentCliUpdateSource, CliInstallation } from './agentCliUpdateSource'
import { CliVersion } from './shared/cliVersion'
import { ErrorText } from '../shared/errorText'

export class AgentCliUpdates {
  private readonly sources: readonly AgentCliUpdateSource[]
  private readonly onChanged: () => void
  private readonly rows: Map<string, AgentCliUpdateRow>
  private readonly pending = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private revision = 0

  constructor(sources: readonly AgentCliUpdateSource[], onChanged: () => void) {
    this.sources = sources
    this.onChanged = onChanged
    this.rows = new Map(sources.map(source => [source.id, {
      id: source.id, label: source.label, activity: 'idle', installedVersion: null, latestVersion: null,
      path: null, channel: null, available: false, canUpdate: false, detail: null, error: null, output: '', checkedAt: null,
    }]))
  }

  snapshot(): AgentCliUpdatesSnapshot {
    return { revision: this.revision, agents: [...this.rows.values()].map(row => ({ ...row })) }
  }

  start(): void {
    if (this.timer !== null || this.lifetime.signal.aborted) return
    const tick = (): void => {
      void this.check()
      this.timer = setTimeout(tick, 60 * 60_000)
      this.timer.unref?.()
    }
    this.timer = setTimeout(tick, 15_000)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.lifetime.abort()
    await Promise.allSettled(this.pending.values())
  }

  async check(): Promise<void> {
    await Promise.all(this.sources.map(source => this.perform(source, 'checking', async () => {
      await this.read(source)
    })))
  }

  async install(id: string): Promise<void> {
    const source = this.sources.find(item => item.id === id)
    if (!source) throw new Error('Unknown CLI update target')
    if (this.pending.has(id)) throw new Error('This CLI already has an operation in progress. Try again when it finishes.')
    await this.perform(source, 'updating', async () => {
      this.patch(id, { output: '' })
      const installation = await this.read(source)
      const row = this.rows.get(id)!
      if (installation === null || !row.available) return
      if (!installation.updateSupported) throw new Error(row.detail ?? 'This CLI cannot update itself.')
      const target = row.latestVersion!
      await source.update(installation, this.lifetime.signal, text => {
        this.patch(id, { output: (this.rows.get(id)!.output + text).slice(-32_768) })
      })
      const after = await source.inspect(this.lifetime.signal)
      if (after === null) throw new Error('The updated CLI could not be found on PATH.')
      if (after.command.path !== installation.command.path)
        throw new Error('The CLI resolved to a different installation after updating. Check PATH and retry.')
      this.patch(id, { installedVersion: after.version, path: after.command.path,
        available: CliVersion.newerRelease(target, after.version) })
      if (CliVersion.newerRelease(target, after.version))
        throw new Error(`The updater finished, but ${after.version} is still installed (expected ${target} or newer). If Windows has locked the executable, finish the running sessions and retry.`)
      this.patch(id, { detail: 'Updated. New sessions will use this version; existing sessions keep running.' })
    })
  }

  private async read(source: AgentCliUpdateSource): Promise<CliInstallation | null> {
    const installation = await source.inspect(this.lifetime.signal)
    if (installation === null) {
      this.patch(source.id, { installedVersion: null, latestVersion: null, path: null, channel: null,
        available: false, canUpdate: false, detail: 'Not installed on this computer.', checkedAt: Date.now() })
      return null
    }
    const previousRelease = this.rows.get(source.id)!.latestVersion
    this.patch(source.id, { installedVersion: installation.version, path: installation.command.path,
      available: previousRelease !== null && CliVersion.newerRelease(previousRelease, installation.version),
      channel: installation.channel, canUpdate: installation.updateSupported })
    const latestVersion = await source.latest(installation, this.lifetime.signal)
    this.patch(source.id, { latestVersion, available: CliVersion.newerRelease(latestVersion, installation.version),
      checkedAt: Date.now(), detail: installation.updateSupported ? null : 'This CLI version needs an update through its package manager.' })
    return installation
  }

  private perform(source: AgentCliUpdateSource, activity: 'checking' | 'updating', run: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(source.id)
    if (existing) return existing
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.patch(source.id, { activity, error: null })
    const pending = Promise.resolve().then(run).catch(error => {
      if (!this.lifetime.signal.aborted) this.patch(source.id, { error: ErrorText.of(error) })
    }).finally(() => {
      this.pending.delete(source.id)
      this.patch(source.id, { activity: 'idle' })
    })
    this.pending.set(source.id, pending)
    return pending
  }

  private patch(id: string, change: Partial<AgentCliUpdateRow>): void {
    if (this.lifetime.signal.aborted) return
    Object.assign(this.rows.get(id)!, change)
    this.revision++
    this.onChanged()
  }
}
