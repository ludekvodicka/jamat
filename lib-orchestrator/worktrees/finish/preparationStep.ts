import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { PathCompare } from '../../shared/pathCompare'
import { SetupInputs } from '../../projectSetup/setupInputs'
import { WorktreeConfig } from '../../projectSetup/worktreeConfig'
import { SvnAssemblyReader, type SvnAssembly } from '../../svn/svnAssembly'
import { SvnCommitGate } from '../../svn/svnCommitGate'
import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'
import { WorktreeWords } from '../view/worktreeWords'

const manifestSchema = z.object({ format: z.literal(1), content: z.string(), metadata: z.string(), incoming: z.array(z.string()),
  nodes: z.array(z.object({ path: z.string(), content: z.string(), metadata: z.string() })) })

export class PreparationStep {
  private readonly deps: Pick<FinishDriverDeps, 'svn' | 'records' | 'results' | 'now' | 'commands' | 'checks' | 'steps' | 'resolutions'>
  private readonly state: Pick<FinishState, 'write' | 'wait'>

  constructor(deps: PreparationStep['deps'], state: PreparationStep['state']) { this.deps = deps; this.state = state }

  async begin(sessionId: string): Promise<boolean> {
    const record = this.deps.records.get(sessionId)!, state = record.worktreeLifecycle!
    const root = state.execution!.root
    const recovered = await this.deps.resolutions.recoverLocked(root, this.deps.results.savedDirectoryOf(state.actionId!), state.actionId!,
      state.syncConflictSet?.entries.flatMap((entry) => entry.state === 'settled' || entry.occurrenceId === undefined ? [] : [entry.occurrenceId]))
    if (!recovered.ok) { await this.state.wait(sessionId, 'locked', recovered.detail); return false }
    const declared = await this.deps.checks.declaredAfter(record, undefined)
    if (!declared.ok) throw new Error(declared.result.ok ? 'Checks unavailable' : declared.result.detail)
    await this.state.write(sessionId, (current) => ({ ...current, approvedAt: undefined, review: undefined, checks: undefined,
      execution: { ...current.execution!, checks: declared.steps.map((step) => ({ ...step, scriptId: 'checks' as const })), checkCursor: 0 } }))
    // Depth-empty adds let SVN enumerate each next level using its own ignore and autoprop rules.
    for (let depth = 0; ; depth++) {
      if (depth >= 256) throw new Error('SVN preparation exceeded 256 directory levels')
      const roots = await this.deps.svn.reviewRoots(root)
      if (!roots.ok) throw new Error(roots.detail)
      let added = 0
      for (const mount of roots.value) {
        if (mount.changed.length === 0) continue
        if (mount.pinned) throw new Error(`A changed external is pinned: ${mount.path}`)
        const prepared = await this.deps.svn.prepareCommit(mount.path, mount.changed.map((row) => resolve(root, row.path)), async (paths) => {
          await this.state.write(sessionId, (current) => ({ ...current, preparationIntent: { root: mount.path, paths, at: this.deps.now() },
            preparationAdds: [...current.preparationAdds?.filter((row) => row.root !== mount.path) ?? [],
              { root: mount.path, paths: [...new Set([...current.preparationAdds?.find((row) => row.root === mount.path)?.paths ?? [], ...paths])] }] }))
        }, true)
        if (!prepared.ok && prepared.code === 'refused' && SvnCommitGate.isGateRefusal(prepared.detail)) { await this.invalidate(sessionId, WorktreeWords.refusedOf(prepared.detail)); return false }
        if (!prepared.ok) throw new Error(prepared.detail)
        added += prepared.value.added.length
        await this.state.write(sessionId, (current) => ({ ...current, preparationIntent: undefined }))
      }
      if (added === 0) break
    }
    await this.deps.commands.accept(root)
    const assembly = await this.read(sessionId)
    const second = await this.read(sessionId)
    if (assembly.content !== second.content || assembly.metadata !== second.metadata)
      throw new Error('The worktree changed while preparation was reading it; pause edits and prepare again')
    const current = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const inputs = SetupInputs.of(assembly.nodes)
    const checksPolicy = await this.checksPolicy(sessionId)
    const environment = current.environment
    const previous = environment ?? record.worktree?.setupBaseline
    if (environment?.pending || checksPolicy !== undefined && environment?.checksPolicy !== checksPolicy
      || (inputs.paths.length > 0 || previous?.inputs !== undefined) && previous?.inputs !== inputs.digest
      || declared.environment !== previous?.commands) {
      // The agreed install answers changed dependency inputs by itself, once per sync; changed checks stay the person's.
      const install = declared.install
      if (checksPolicy === undefined && install !== undefined && current.execution!.refresh === undefined) {
        await this.state.write(sessionId, (latest) => ({ ...latest, preparation: undefined, wait: undefined,
          environment: latest.environment?.pending ? undefined : latest.environment,
          execution: { ...latest.execution!, refresh: { steps: [install], cursor: 0, paths: SetupInputs.changed(inputs, previous?.inputHashes) } } }))
        return true
      }
      await this.state.write(sessionId, (latest) => ({ ...latest, preparation: undefined,
        environment: { inputs: inputs.digest, commands: declared.environment, checksPolicy, inputHashes: inputs.hashes, at: this.deps.now(), source: 'person', pending: true,
          paths: [...SetupInputs.changed(inputs, previous?.inputHashes), ...checksPolicy === undefined ? [] : ['.worktree.json (checks changed)']] } }))
      await this.state.wait(sessionId, 'review', checksPolicy !== undefined && environment?.checksPolicy !== checksPolicy
        ? 'Checks changed in the worktree. New checks were not executed: Finish uses the main working copy configuration. Inspect the changes and explicitly confirm this validation policy before continuing.'
        : install === undefined ? 'Dependency inputs changed or their last setup is unverified, and this project has no install Jamat can run. Bring the worktree environment up to date, then confirm it before checks.'
        : 'Dependency inputs changed again after the install ran in this sync. Bring the worktree environment up to date, then confirm it before checks, or press Read inputs again to run the install once more.')
      return false
    }
    const path = await this.save(sessionId, assembly)
    await this.state.write(sessionId, (latest) => ({ ...latest, preparation: { format: 1, manifest: path,
      content: assembly.content, metadata: assembly.metadata, commands: SvnAssemblyReader.hash(current.execution!.checks), environment: declared.environment,
      checks: 'pending', attempt: state.execution?.preparationRound ?? 0 } }))
    return true
  }

  async confirmEnvironment(sessionId: string): Promise<boolean> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    if (state.environment?.pending !== true) return false
    const inputs = SetupInputs.of((await this.read(sessionId)).nodes)
    const checksPolicy = await this.checksPolicy(sessionId)
    const declared = await this.deps.checks.declaredAfter(this.deps.records.get(sessionId)!, undefined)
    if (!declared.ok || inputs.digest !== state.environment.inputs || declared.environment !== state.environment.commands || checksPolicy !== state.environment.checksPolicy) return false
    await this.state.write(sessionId, (latest) => ({ ...latest, phase: 'finishing', step: 'checking', wait: undefined, preparation: undefined,
      environment: { inputs: inputs.digest, commands: declared.environment, checksPolicy, paths: inputs.paths, inputHashes: inputs.hashes, at: this.deps.now(), source: 'person' } }))
    return true
  }

  /** The install ran again: the inputs as it left them are the environment the checks run in. */
  async refreshed(sessionId: string): Promise<void> {
    const inputs = SetupInputs.of((await this.read(sessionId)).nodes)
    const declared = await this.deps.checks.declaredAfter(this.deps.records.get(sessionId)!, undefined)
    if (!declared.ok) throw new Error(declared.result.ok ? 'Checks unavailable' : declared.result.detail)
    await this.state.write(sessionId, (latest) => ({ ...latest, preparation: undefined,
      environment: { inputs: inputs.digest, commands: declared.environment, paths: inputs.paths, inputHashes: inputs.hashes, at: this.deps.now(), source: 'setup' },
      execution: { ...latest.execution!, refresh: { ...latest.execution!.refresh!, endedAt: this.deps.now() } } }))
  }

  /** The install failed: the person repairs the environment and confirms it, or reads the inputs again to rerun it. */
  async refreshFailed(sessionId: string, reason: string, logPath: string | null): Promise<void> {
    const inputs = SetupInputs.of((await this.read(sessionId)).nodes)
    const declared = await this.deps.checks.declaredAfter(this.deps.records.get(sessionId)!, undefined)
    if (!declared.ok) throw new Error(declared.result.ok ? 'Checks unavailable' : declared.result.detail)
    await this.state.write(sessionId, (latest) => ({ ...latest, preparation: undefined,
      environment: { inputs: inputs.digest, commands: declared.environment, inputHashes: inputs.hashes, at: this.deps.now(), source: 'person', pending: true,
        paths: SetupInputs.changed(inputs, (latest.environment?.pending ? undefined : latest.environment ?? this.deps.records.get(sessionId)!.worktree?.setupBaseline)?.inputHashes) },
      execution: { ...latest.execution!, refresh: { ...latest.execution!.refresh!, endedAt: this.deps.now() } } }))
    await this.state.wait(sessionId, 'review', `Dependency inputs changed and the setup that refreshes them failed: ${reason}.`
      + `${logPath === null ? '' : ` Log: ${logPath}.`} Repair the worktree environment, then press Read inputs again to run the setup again, or confirm the environment.`)
  }

  /**
   * Revokes approval when the prepared assembly is no longer current, reading repository freshness.
   * A refused incoming change stays known until an update takes it: Recheck reads no freshness.
   */
  async refuseStale(sessionId: string): Promise<string | null> {
    const known = this.deps.records.get(sessionId)!.worktreeLifecycle!.knownIncoming
    const problem = known === undefined ? await this.inspect(sessionId, true) : { kind: 'incoming' as const, reason: PreparationStep.incomingReason(known.paths), paths: known.paths }
    if (problem === null) return null
    await this.invalidate(sessionId, problem.reason, problem.kind === 'incoming' ? problem.paths : [])
    return problem.reason
  }

  private static incomingReason(paths: readonly string[]): string {
    return `Repository changes require a new preparation and confirmation: ${paths.join(', ')}`
  }

  private async checksPolicy(sessionId: string): Promise<string | undefined> {
    const record = this.deps.records.get(sessionId)!
    if (record.worktree === undefined) return undefined
    const read = async (root: string) => {
      const loaded = await WorktreeConfig.load(root)
      const section = WorktreeConfig.sectionOf(loaded, 'scripts', (value) => ({ ok: true, value }))
      if (!section.ok) throw new Error(section.problem)
      return section.value
    }
    const main = await read(record.worktree.repositoryRoot), tree = await read(record.worktree.worktreePath)
    return SvnAssemblyReader.hash(main) === SvnAssemblyReader.hash(tree) ? undefined : SvnAssemblyReader.hash([main, tree])
  }

  private async inspect(sessionId: string, freshness = false): Promise<{ kind: 'manifest' | 'declarations' | 'changed'; reason: string }
    | { kind: 'incoming'; reason: string; paths: string[] } | null> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    // A refused or interrupted preparation waits in review with its own reason; repeating it names what to fix.
    if (state.preparation === undefined) return { kind: 'manifest', reason: state.wait?.kind === 'review' ? state.wait.reason
      : 'This Finish has no verified assembly; prepare and test it before approving publication' }
    const previous = await this.saved(sessionId)
    if (previous === null) return { kind: 'manifest', reason: 'The preparation manifest is missing or invalid; prepare and test the worktree again' }
    const declared = await this.deps.checks.declaredAfter(this.deps.records.get(sessionId)!, undefined)
    if (!declared.ok) return { kind: 'declarations', reason: declared.result.ok ? 'Checks are unavailable' : declared.result.detail }
    const commands = declared.steps.map((step) => ({ ...step, scriptId: 'checks' as const }))
    if (SvnAssemblyReader.hash(commands) !== state.preparation.commands || declared.environment !== state.preparation.environment)
      return { kind: 'declarations', reason: 'Declared checks or setup commands changed; prepare and test the worktree again' }
    const assembly = await this.read(sessionId, freshness)
    if (assembly.content !== previous.content || assembly.metadata !== previous.metadata) {
      const before = new Map(previous.nodes.map((node) => [node.path, node]))
      const after = new Map(assembly.nodes.map((node) => [node.path, node]))
      const paths = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path)?.content !== after.get(path)?.content
        || before.get(path)?.metadata !== after.get(path)?.metadata)
      return { kind: 'changed', reason: `The application or an external changed after preparation; run preparation and checks again. Changed (${paths.length}): ${paths.slice(0, 20).join(', ')}${paths.length > 20 ? ', …' : ''}` }
    }
    if (assembly.incoming.length > 0) return { kind: 'incoming', reason: PreparationStep.incomingReason(assembly.incoming), paths: assembly.incoming }
    return null
  }

  async checked(sessionId: string, overridden = false): Promise<boolean> {
    const problem = await this.inspect(sessionId)
    if (problem !== null) {
      const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
      if (!overridden && problem.kind === 'changed' && (state.preparation?.attempt ?? 0) < 2)
        await this.state.write(sessionId, (latest) => ({ ...latest, preparation: undefined, approvedAt: undefined, checks: undefined,
          execution: { ...latest.execution!, preparationRound: (state.preparation?.attempt ?? 0) + 1,
            checkCursor: 0, checkBefore: undefined, runId: undefined, verdict: undefined } }))
      else await this.invalidate(sessionId, problem.reason)
      return false
    }
    await this.state.write(sessionId, (state) => ({ ...state, preparation: { ...state.preparation!, checkedAt: this.deps.now(),
      checks: overridden ? 'overridden' : state.execution!.checks.length === 0 ? 'none' : 'passed' } }))
    return true
  }

  async invalidate(sessionId: string, reason: string, incoming: readonly string[] = []): Promise<void> {
    await this.state.write(sessionId, (state) => ({ ...state, approvedAt: undefined, checks: undefined,
      ...incoming.length === 0 ? {} : { knownIncoming: { paths: [...incoming], at: this.deps.now() } },
      preparation: state.preparation === undefined ? undefined : { ...state.preparation, checks: 'pending', checkedAt: undefined },
      phase: 'waiting', step: 'reviewing', wait: { kind: 'review', reason, at: this.deps.now() },
      review: state.review === undefined ? undefined : { ...state.review, version: state.version + 1 } }))
  }

  async advanceReceipt(sessionId: string, root: string, paths: readonly string[]): Promise<boolean> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const previous = await this.saved(sessionId)
    if (previous === null) { await this.invalidate(sessionId, 'Published revision retained; prepare the remaining worktree before further publication'); return false }
    const next = await this.read(sessionId)
    const old = new Map(previous.nodes.map((node) => [node.path, node]))
    const current = new Map(next.nodes.map((node) => [node.path, node]))
    const changed = [...new Set([...old.keys(), ...current.keys()])].filter((path) => old.get(path)?.metadata !== current.get(path)?.metadata)
    const expected = paths.map((path) => resolve(root, path))
    const allowed = changed.every((path) => path.startsWith('@mount/')
      ? PathCompare.comparable(resolve(state.execution!.root, path.slice(7))) === PathCompare.comparable(root)
      : expected.some((selection) => PathCompare.comparable(selection) === PathCompare.comparable(resolve(state.execution!.root, path))))
    if (previous.content !== next.content || !allowed) {
      await this.invalidate(sessionId, 'Published revision retained, but the assembly changed during publication; prepare the remaining repositories again')
      return false
    }
    const manifest = await this.save(sessionId, next)
    await this.state.write(sessionId, (latest) => ({ ...latest, preparation: { ...latest.preparation!, manifest, metadata: next.metadata } }))
    return true
  }

  private async read(sessionId: string, freshness = false): Promise<SvnAssembly> {
    const root = this.deps.records.get(sessionId)!.worktreeLifecycle!.execution!.root
    try {
      const read = await this.deps.svn.assembly(root, freshness, (mount, count) => {
        this.deps.steps.at(sessionId, { kind: 'read', read: 'assembly', mount, count })
      })
      if (!read.ok) throw new Error(read.detail)
      return read.value
    } finally { this.deps.steps.clear(sessionId) }
  }

  private async save(sessionId: string, assembly: SvnAssembly): Promise<string> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const directory = this.deps.results.savedDirectoryOf(state.actionId!)
    await AtomicJsonFile.ensureDirectoryAsync(directory)
    // Immutable manifests keep a crash between the manifest and record writes recoverable.
    const file = join(directory, `preparation-${assembly.content}-${assembly.metadata}.json`)
    await AtomicJsonFile.writeAsync(file, assembly)
    return file
  }

  private async saved(sessionId: string): Promise<SvnAssembly | null> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!, preparation = state.preparation
    if (preparation === undefined) return null
    const expected = join(this.deps.results.savedDirectoryOf(state.actionId!), `preparation-${preparation.content}-${preparation.metadata}.json`)
    if (PathCompare.comparable(expected) !== PathCompare.comparable(preparation.manifest)) return null
    try {
      const parsed = manifestSchema.safeParse(JSON.parse(await readFile(expected, 'utf8')))
      if (!parsed.success) return null
      const value = parsed.data
      if (value.content !== preparation.content || value.metadata !== preparation.metadata
        || SvnAssemblyReader.hash(value.nodes.filter((node) => node.content !== '').map(({ path, content }) => [path, content])) !== value.content
        || SvnAssemblyReader.hash(value.nodes.map(({ path, metadata }) => [path, metadata])) !== value.metadata) return null
      return value
    } catch { return null }
  }
}
