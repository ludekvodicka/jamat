import { chooseDefault, type DefaultAccountChoice } from './defaultAccount'
import type { RateAccountState } from '../rateMonitor/rateMonitorApi.types'
import { AccountProblem } from './accountProblem'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Slug } from '../shared/slug'
import { ErrorText } from '../shared/errorText'
import type { AccountAgentId, AccountId, AccountIdentity, AccountLaunchSettings, AccountView, RetainProfile } from './agentAccountsApi.types'
import { ProfileProvisioner } from './profiles/profileProvisioner'
import type { AgentProfileSpec, IdentityProbe } from './profiles/profileShareTable'

export interface StoredAccount {
  id: AccountId
  agentId: AccountAgentId
  label: string
  enabled: boolean
  identity: AccountIdentity | null
}

export interface AgentAccountsDeps {
  mainHomes: Readonly<Record<AccountAgentId, string>>
  specs: readonly AgentProfileSpec[]
  stored(): readonly StoredAccount[]
  store(accounts: readonly StoredAccount[]): void
  accountsRoot: string
  hasRunningSession(agentId: AccountAgentId, accountId: AccountId): boolean
  rates?: () => readonly RateAccountState[]
  onChanged(): void
  login?: {
    open(request: { agentId: AccountAgentId; accountId: AccountId; home: string; command: string; label: string; prepare: () => Promise<Record<string, string>> }): Promise<{ sessionId: string }>
    result(sessionId: string): { ended: false } | { ended: true; exitCode: number | null }
    stop(sessionId: string): Promise<void>
  }
}

interface LoginRun {
  sessionId: string | null
  deadline: number
  checking: boolean
}

export class AgentAccounts {
  private readonly deps: AgentAccountsDeps
  private readonly provisioner: ProfileProvisioner
  private readonly specs: ReadonlyMap<AccountAgentId, AgentProfileSpec>
  private readonly locks = new Map<AccountId, Promise<unknown>>()
  private readonly profileUses: Map<AccountId, Set<Promise<void>>>
  private readonly logins = new Map<AccountId, LoginRun>()
  private loginTimer: ReturnType<typeof setInterval> | null = null
  private readonly problems = new Map<AccountId, string>()
  private readonly probes = new Map<string, { at: number; result: Promise<IdentityProbe> }>()

  constructor(deps: AgentAccountsDeps) {
    this.deps = deps
    this.provisioner = new ProfileProvisioner(deps.accountsRoot)
    this.specs = new Map(deps.specs.map(spec => [spec.agentId, spec]))
    this.profileUses = new Map()
  }

  async list(exclude?: { agentId: AccountAgentId; accountId: string }): Promise<readonly AccountView[]> {
    const mains = Object.entries(this.deps.mainHomes).map(([agent, home]) => ({ agentId: agent as AccountAgentId, home }))
    const views = await Promise.all(mains.map(async ({ agentId, home }): Promise<AccountView> => ({
      agentId, accountId: 'main', label: 'Main', isMain: true,
      ...this.probeView(await this.probe(agentId, 'main', home), null, true),
    })))
    for (const account of this.deps.stored()) {
      const result = account.identity === null ? null : await this.probe(account.agentId, account.id,
        join(this.deps.accountsRoot, account.agentId, account.id))
      const view = this.probeView(result, account.identity, false)
      views.push({ agentId: account.agentId, accountId: account.id, label: account.label, isMain: false,
        ...view, state: account.enabled ? view.state : 'disabled',
        profileProblem: this.problems.get(account.id) ?? view.profileProblem })
    }
    if (this.deps.rates) {
      const rates = this.deps.rates()
      for (const agentId of Object.keys(this.deps.mainHomes) as AccountAgentId[]) {
        const choice = chooseDefault(agentId, views.filter(account => account.agentId !== exclude?.agentId || account.accountId !== exclude.accountId), rates)
        const selected = views.find(account => account.agentId === agentId && account.accountId === choice.accountId)
        if (selected) selected.defaultChoice = { noFreeAccount: choice.noFreeAccount, resetsAt: choice.resetsAt ?? null }
      }
    }
    return views
  }

  async add(agentId: AccountAgentId, label: string): Promise<{ accountId: AccountId }> {
    const spec = this.specs.get(agentId)
    if (!spec) throw new AccountProblem(`Adding ${agentId} accounts is not available`)
    const cleanLabel = this.label(label)
    const id = `${Slug.of(cleanLabel) || 'account'}-${randomBytes(4).toString('hex')}`
    return this.lock(id, async retain => {
      const home = join(this.deps.accountsRoot, agentId, id)
      await this.provisioner.create(spec, home)
      try {
        await spec.beforeLaunch?.(home, spec.mainHome(), undefined, undefined, retain)
        this.deps.store([...this.deps.stored(), { id, agentId, label: cleanLabel, enabled: true, identity: null }])
      } catch (error) {
        const uses = this.profileUses.get(id)
        if (uses) {
          void Promise.all(uses).then(() => this.lock(id, () => this.provisioner.remove(home))).catch(cleanupError => {
            this.problems.set(id, `Profile cleanup failed: ${ErrorText.of(cleanupError)}`)
            this.deps.store([...this.deps.stored(), { id, agentId, label: cleanLabel, enabled: false, identity: null }])
            this.deps.onChanged()
          })
        } else await this.provisioner.remove(home)
        throw error
      }
      this.deps.onChanged()
      return { accountId: id }
    })
  }

  async login(accountId: AccountId): Promise<{ sessionId: string }> {
    const port = this.deps.login
    if (!port) throw new AccountProblem('Account login is not available')
    if (this.logins.has(accountId)) throw new AccountProblem('The account has a login in progress')
    const run: LoginRun = { sessionId: null, deadline: Date.now() + 15 * 60_000, checking: false }
    this.logins.set(accountId, run)
    try {
      const request = await this.lock(accountId, async () => {
        const account = this.added(accountId)
        if (!account.enabled) throw new AccountProblem('Enable the account before logging in')
        const spec = this.specs.get(account.agentId)
        if (!spec) throw new AccountProblem('Account provider is not available')
        this.problems.delete(accountId)
        return { agentId: account.agentId, accountId, home: this.homeOf(account.agentId, accountId), command: spec.loginCommand, label: account.label }
      })
      let prepared = false
      const opened = await port.open({ ...request, prepare: () => {
        if (prepared || this.logins.get(accountId) !== run) throw new AccountProblem('Login preparation is no longer available')
        prepared = true
        return this.prepareProfile(request.agentId, accountId, false)
      } })
      run.sessionId = opened.sessionId
      if (this.loginTimer === null) this.loginTimer = setInterval(() => this.sessionsChanged(), 5_000)
      this.sessionsChanged()
      this.deps.onChanged()
      return opened
    } catch (error) {
      this.finishLogin(accountId)
      this.problems.set(accountId, ErrorText.of(error))
      this.deps.onChanged()
      throw error
    }
  }

  sessionsChanged(): void {
    for (const [accountId, run] of this.logins) {
      if (run.checking || run.sessionId === null) continue
      run.checking = true
      void this.checkLogin(accountId, run).catch(error => {
        this.finishLogin(accountId)
        this.problems.set(accountId, ErrorText.of(error))
        this.deps.onChanged()
      }).finally(() => { run.checking = false })
    }
  }

  stop(): void {
    if (this.loginTimer !== null) clearInterval(this.loginTimer)
    this.loginTimer = null
    this.logins.clear()
  }

  private async checkLogin(accountId: AccountId, run: LoginRun): Promise<void> {
    const port = this.deps.login!
    const sessionId = run.sessionId!
    const timedOut = Date.now() >= run.deadline
    let terminal = port.result(sessionId)
    if (timedOut && !terminal.ended) {
      await port.stop(sessionId)
      terminal = port.result(sessionId)
      if (!terminal.ended) throw new AccountProblem('Login timed out; stop its terminal before removing the account')
    }
    if (!terminal.ended) return
    const account = this.added(accountId)
    if (!timedOut && terminal.exitCode === 0) {
      const registered = await this.lock(accountId, async retain => {
        const current = this.added(accountId)
        const spec = this.specs.get(current.agentId)!
        const result = await spec.probe(this.homeOf(current.agentId, accountId), retain)
        switch (result.kind) {
          case 'logged-out': return false
          case 'failed': throw new AccountProblem(result.reason)
          case 'logged-in': {
            if (current.identity !== null && current.identity.key !== result.identity.key)
              throw new AccountProblem('Log in again must use the same account identity')
            const main = await spec.probe(this.deps.mainHomes[current.agentId])
            switch (main.kind) {
              case 'logged-in':
                if (main.identity.key === result.identity.key) throw new AccountProblem('already added as Main')
                break
              case 'logged-out': break
              case 'failed': throw new AccountProblem(`Cannot check the main account identity: ${main.reason}`)
              default: throw new Error(`Unknown identity result: ${JSON.stringify(main)}`)
            }
            const duplicate = this.deps.stored().find(other => other.id !== accountId && other.agentId === current.agentId
              && other.identity?.key === result.identity.key)
            if (duplicate) throw new AccountProblem(`already added as ${duplicate.label}`)
            this.deps.store(this.deps.stored().map(other => other.id === accountId ? { ...other, identity: result.identity } : other))
            this.probes.delete(`${current.agentId}/${accountId}`)
            this.problems.delete(accountId)
            return true
          }
          default: throw new Error(`Unknown identity result: ${JSON.stringify(result)}`)
        }
      })
      if (registered) { this.finishLogin(accountId); this.deps.onChanged(); return }
    }
    this.finishLogin(accountId)
    if (account.identity === null) await this.remove(accountId)
    else {
      this.problems.set(accountId, timedOut ? 'Login timed out after 15 minutes' : 'Login did not complete successfully')
      this.deps.onChanged()
    }
  }

  private finishLogin(accountId: AccountId): void {
    this.logins.delete(accountId)
    if (this.logins.size === 0 && this.loginTimer !== null) {
      clearInterval(this.loginTimer)
      this.loginTimer = null
    }
  }

  async rename(accountId: AccountId, label: string): Promise<void> {
    const cleanLabel = this.label(label)
    return this.update(accountId, account => ({ ...account, label: cleanLabel }))
  }

  async setEnabled(accountId: AccountId, enabled: boolean): Promise<void> {
    return this.update(accountId, account => ({ ...account, enabled }))
  }

  async remove(accountId: AccountId): Promise<void> {
    this.added(accountId)
    if (this.logins.has(accountId)) throw new AccountProblem('The account has a login in progress')
    if (this.locks.has(accountId) || this.profileUses.has(accountId)) throw new AccountProblem('The account has an operation in progress')
    return this.lock(accountId, async () => {
      const account = this.added(accountId)
      if (this.deps.hasRunningSession(account.agentId, accountId)) throw new AccountProblem(`a session runs on ${account.label}`)
      await this.provisioner.remove(this.homeOf(account.agentId, accountId))
      this.deps.store(this.deps.stored().filter(item => item.id !== accountId))
      this.probes.delete(`${account.agentId}/${accountId}`)
      this.deps.onChanged()
    })
  }

  homeOf(agentId: AccountAgentId, accountId: AccountId): string {
    if (accountId === 'main') return this.deps.mainHomes[agentId]
    const account = this.added(accountId)
    if (account.agentId !== agentId) throw new AccountProblem('Account belongs to another agent')
    return join(this.deps.accountsRoot, agentId, account.id)
  }

  exists(agentId: AccountAgentId, accountId: AccountId): boolean {
    return accountId === 'main' || this.deps.stored().some(account => account.agentId === agentId && account.id === accountId)
  }

  labelOf(agentId: AccountAgentId, accountId: AccountId): string | null {
    if (accountId === 'main') return null
    return this.deps.stored().find(account => account.agentId === agentId && account.id === accountId)?.label ?? accountId
  }

  homesOf(agentId: AccountAgentId): string[] {
    return [this.deps.mainHomes[agentId], ...this.deps.stored().filter(account => account.agentId === agentId)
      .map(account => join(this.deps.accountsRoot, agentId, account.id))]
  }

  defaultAccount(agentId: AccountAgentId): DefaultAccountChoice | Promise<DefaultAccountChoice> {
    return this.list().then(accounts => chooseDefault(agentId, accounts, this.deps.rates?.() ?? []))
  }

  async usable(agentId: AccountAgentId, accountId: AccountId): Promise<boolean> {
    return (await this.list()).some(account => account.agentId === agentId && account.accountId === accountId && account.state === 'active')
  }

  async launchEnv(agentId: AccountAgentId, accountId: AccountId, cwd?: string, settings?: AccountLaunchSettings): Promise<Record<string, string>> {
    if (accountId === 'main') return {}
    return this.prepareProfile(agentId, accountId, true, cwd, settings)
  }

  private async prepareProfile(agentId: AccountAgentId, accountId: AccountId, requireIdentity: boolean, cwd?: string,
    settings?: AccountLaunchSettings): Promise<Record<string, string>> {
    return this.lock(accountId, retain => this.prepareProfileLocked(agentId, accountId, requireIdentity, cwd, settings, retain))
  }

  async withProfile<T>(agentId: AccountAgentId, accountId: AccountId, operation: (retain?: RetainProfile) => Promise<T>): Promise<T> {
    if (accountId === 'main') return operation()
    return this.lock(accountId, async retain => {
      await this.prepareProfileLocked(agentId, accountId, true, this.homeOf(agentId, accountId), undefined, retain)
      return operation(retain)
    })
  }

  private async prepareProfileLocked(agentId: AccountAgentId, accountId: AccountId, requireIdentity: boolean, cwd?: string,
    settings?: AccountLaunchSettings, retain?: RetainProfile): Promise<Record<string, string>> {
    const account = this.added(accountId)
    if (account.agentId !== agentId || !account.enabled) throw new AccountProblem('Account is not usable')
    const spec = this.specs.get(agentId)
    if (!spec) throw new AccountProblem('Account provider is not available')
    const home = this.homeOf(agentId, accountId)
    try {
      await this.provisioner.repair(spec, home)
      if (requireIdentity) {
        if (this.logins.has(accountId)) throw new AccountProblem('The account has a login in progress')
        if (account.identity === null) throw new AccountProblem(this.problems.get(accountId) ?? 'Account login is not registered')
        const result = await spec.probe(home, retain)
        switch (result.kind) {
          case 'logged-in':
            if (account.identity.key !== result.identity.key)
              throw new AccountProblem(this.problems.get(accountId) ?? 'Log in again must use the same account identity')
            break
          case 'logged-out': throw new AccountProblem(this.problems.get(accountId) ?? 'Account needs login')
          case 'failed': throw new AccountProblem(this.problems.get(accountId) ?? result.reason)
          default: throw new Error(`Unknown identity result: ${JSON.stringify(result)}`)
        }
      }
      await spec.beforeLaunch?.(home, spec.mainHome(), cwd, settings, retain)
      this.problems.delete(accountId)
      return { [spec.homeVariable]: home, ...spec.extraEnv(spec.mainHome()) }
    } catch (error) {
      this.problems.set(accountId, ErrorText.of(error))
      this.deps.onChanged()
      throw error
    }
  }

  private probeView(result: IdentityProbe | null, identity: AccountIdentity | null, main: boolean):
    Pick<AccountView, 'state' | 'identity' | 'profileProblem'> {
    if (result === null) return { state: main || identity !== null ? 'active' : 'pending-login', identity, profileProblem: null }
    switch (result.kind) {
      case 'logged-in': return { state: identity !== null && identity.key !== result.identity.key ? 'needs-login' : 'active',
        identity: main ? result.identity : identity, profileProblem: null }
      case 'logged-out': return { state: 'needs-login', identity, profileProblem: null }
      case 'failed': return { state: main || identity !== null ? 'active' : 'pending-login', identity, profileProblem: result.reason }
      default: throw new Error(`Unknown identity result: ${JSON.stringify(result)}`)
    }
  }

  private async update(accountId: AccountId, update: (account: StoredAccount) => StoredAccount): Promise<void> {
    this.added(accountId)
    return this.lock(accountId, async () => {
      const next = update(this.added(accountId))
      this.deps.store(this.deps.stored().map(account => account.id === accountId ? next : account))
      this.deps.onChanged()
    })
  }

  private added(accountId: AccountId): StoredAccount {
    if (accountId === 'main') throw new AccountProblem('The main account cannot be changed or removed')
    const account = this.deps.stored().find(item => item.id === accountId)
    if (!account) throw new AccountProblem('Account not found')
    return account
  }

  private label(label: string): string {
    const clean = label.trim()
    if (!clean || clean.length > 100) throw new AccountProblem('Account label must have 1 to 100 characters')
    return clean
  }

  private probe(agentId: AccountAgentId, accountId: AccountId, home: string): Promise<IdentityProbe> | null {
    const spec = this.specs.get(agentId)
    if (!spec) return null
    const key = `${agentId}/${accountId}`
    const cached = this.probes.get(key)
    if (cached && Date.now() - cached.at < 60_000) return cached.result
    const read = accountId === 'main' ? spec.probe(home) : this.lock(accountId, async retain => {
      this.added(accountId)
      return spec.probe(home, retain)
    })
    const result = read.catch((): IdentityProbe => ({ kind: 'failed', reason: 'Account identity probe failed' }))
    this.probes.set(key, { at: Date.now(), result })
    return result
  }

  private retain(accountId: AccountId, until: Promise<void>): void {
    const uses = this.profileUses.get(accountId) ?? new Set<Promise<void>>()
    uses.add(until)
    this.profileUses.set(accountId, uses)
    void until.then(() => {
      uses.delete(until)
      if (uses.size === 0) this.profileUses.delete(accountId)
    }, () => {})
  }

  private async lock<T>(accountId: AccountId, action: (retain: RetainProfile) => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => {
      if (this.profileUses.has(accountId)) throw new AccountProblem('The account has an operation in progress')
      return action(until => this.retain(accountId, until))
    })
    this.locks.set(accountId, current)
    try { return await current }
    finally { if (this.locks.get(accountId) === current) this.locks.delete(accountId) }
  }
}
