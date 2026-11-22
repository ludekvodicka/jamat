import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { ErrorText } from '../../../lib-orchestrator/shared/errorText'

export type SkillLinkAgent = 'claude' | 'codex' | 'antigravity'
export type SkillLinkName = 'appjamat-v3' | 'mdext-renderer' | 'session-automation-groups'
export type SkillLinkResultKind = 'created' | 'current' | 'repointed' | 'refused' | 'failed'

export interface SkillLinkResult {
  agent: SkillLinkAgent
  skill: SkillLinkName
  kind: SkillLinkResultKind
  source: string
  target: string
  detail?: string
}

export interface SkillLinkInstallerDeps {
  repoRoot: string
  homeRoot: string
  codexHome?: string
  antigravityConfigHome?: string
  skip?: boolean
  /** The instance runs with `JAMAT_V3_LOCAL_STATE_DIR`: a measuring or test copy, never the one the links serve. */
  privateStateRoot?: boolean
  /** Resolves a drive alias such as a subst drive; `realpathSync.native` unless a test injects one. */
  realpath?: (path: string) => string
  report(message: string): void
}

export class SkillLinkInstaller {
  private static readonly skillNamesConst: readonly SkillLinkName[] = [
    'appjamat-v3',
    'mdext-renderer',
    'session-automation-groups',
  ]
  private readonly repoRoot: string
  private readonly homeRoot: string
  private readonly codexHome: string
  private readonly antigravityConfigHome: string
  private readonly deps: SkillLinkInstallerDeps

  constructor(deps: SkillLinkInstallerDeps) {
    this.deps = deps
    this.repoRoot = resolve(deps.repoRoot)
    this.homeRoot = resolve(deps.homeRoot)
    this.codexHome = resolve(deps.codexHome ?? join(this.homeRoot, '.codex'))
    this.antigravityConfigHome = resolve(deps.antigravityConfigHome ?? join(this.homeRoot, '.gemini', 'config'))
  }

  install(): readonly SkillLinkResult[] {
    if (this.skipReason() !== null) return []
    const linked = SkillLinkInstaller.skillNamesConst.flatMap(skill => [
      this.installOne(
        skill,
        'claude',
        join(this.repoRoot, 'skills', 'claude', skill),
        join(this.homeRoot, '.claude', 'skills', skill),
      ),
      this.installOne(
        skill,
        'codex',
        join(this.repoRoot, 'skills', 'codex', skill),
        join(this.codexHome, 'skills', skill),
      ),
    ])
    return [...linked, ...this.installAntigravity()]
  }

  roots(): readonly string[] {
    return [
      join(this.homeRoot, '.claude', 'skills'),
      join(this.codexHome, 'skills'),
      join(this.antigravityConfigHome, 'skills'),
    ]
  }

  skipReason(): string | null {
    if (this.deps.privateStateRoot) return 'private state root'
    if (/(?:^|[\\/])\.worktrees(?:[\\/]|$)/i.test(this.realRepoRoot())) return 'worktree checkout'
    if (this.deps.skip) return 'JAMAT_V3_SKIP_SKILL_LINKS=1'
    return null
  }

  private realRepoRoot(): string {
    try { return (this.deps.realpath ?? realpathSync.native)(this.repoRoot) } catch { return this.repoRoot }
  }

  private installOne(
    skill: SkillLinkName,
    agent: SkillLinkAgent,
    source: string,
    target: string,
  ): SkillLinkResult {
    try {
      const sourceStats = lstatSync(source)
      if (!sourceStats.isDirectory())
        return this.report(
          { agent, skill, kind: 'failed', source, target },
          'Skill source is not a directory',
        )
      mkdirSync(resolve(target, '..'), { recursive: true })
      const targetStats = SkillLinkInstaller.lstat(target)
      if (targetStats === null) {
        symlinkSync(source, target, 'junction')
        this.remember(target, source)
        return { agent, skill, kind: 'created', source, target }
      }
      if (!targetStats.isSymbolicLink())
        return this.report(
          { agent, skill, kind: 'refused', source, target },
          'A real file or directory already occupies the skill target',
        )
      const linked = resolve(readlinkSync(target))
      if (SkillLinkInstaller.samePath(linked, source)) {
        this.remember(target, source)
        return { agent, skill, kind: 'current', source, target }
      }
      if (!this.ownedTarget(linked, skill, agent) && !this.recordedTarget(target, linked))
        return this.report(
          { agent, skill, kind: 'refused', source, target },
          `The existing link points outside ${join(this.repoRoot, 'skills')}`,
        )
      SkillLinkInstaller.removeLink(target)
      symlinkSync(source, target, 'junction')
      this.remember(target, source)
      return { agent, skill, kind: 'repointed', source, target }
    } catch (error) {
      return this.report(
        { agent, skill, kind: 'failed', source, target },
        `Skill link could not be installed: ${ErrorText.of(error)}`,
      )
    }
  }

  /**
   * Registers `skills/antigravity` in `~/.gemini/config/skills.json`.
   *
   * Antigravity CLI (`agy`, Go) ignores Windows NTFS directory junctions inside
   * `~/.gemini/config/skills/`, whereas `~/.gemini/config/skills.json` entries are discovered
   * reliably across all platforms without copying files. Any legacy Jamat-owned junctions left
   * inside `~/.gemini/config/skills/` by earlier builds are cleaned up safely.
   */
  private installAntigravity(): readonly SkillLinkResult[] {
    const sourceRoot = join(this.repoRoot, 'skills', 'antigravity')
    const manifestPath = join(this.antigravityConfigHome, 'skills.json')
    const receiptBase = join(this.antigravityConfigHome, 'skills')
    const validSkills: SkillLinkName[] = []
    const failures: SkillLinkResult[] = []
    for (const skill of SkillLinkInstaller.skillNamesConst) {
      const skillSource = join(sourceRoot, skill)
      try {
        if (!lstatSync(skillSource).isDirectory()) {
          failures.push(this.report(
            { agent: 'antigravity', skill, kind: 'failed', source: skillSource, target: manifestPath },
            'Skill source is not a directory',
          ))
          continue
        }
        validSkills.push(skill)
      } catch (error) {
        failures.push(this.report(
          { agent: 'antigravity', skill, kind: 'failed', source: skillSource, target: manifestPath },
          `Skill link could not be installed: ${ErrorText.of(error)}`,
        ))
      }
    }
    if (validSkills.length === 0) return failures

    try {
      mkdirSync(this.antigravityConfigHome, { recursive: true })
      let document: Record<string, unknown> = {}
      let entries: unknown[] = []
      const existingStats = SkillLinkInstaller.lstat(manifestPath)
      if (existingStats !== null) {
        if (!existingStats.isFile())
          return [
            ...failures,
            ...validSkills.map(skill => this.report(
              { agent: 'antigravity', skill, kind: 'refused', source: join(sourceRoot, skill), target: manifestPath },
              'A non-file entry occupies ~/.gemini/config/skills.json',
            )),
          ]
        let parsed: unknown
        try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) }
        catch {
          return [
            ...failures,
            ...validSkills.map(skill => this.report(
              { agent: 'antigravity', skill, kind: 'refused', source: join(sourceRoot, skill), target: manifestPath },
              'Existing ~/.gemini/config/skills.json is not valid JSON',
            )),
          ]
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          return [
            ...failures,
            ...validSkills.map(skill => this.report(
              { agent: 'antigravity', skill, kind: 'refused', source: join(sourceRoot, skill), target: manifestPath },
              'Existing ~/.gemini/config/skills.json must be a JSON object',
            )),
          ]
        document = { ...(parsed as Record<string, unknown>) }
        if (document['entries'] !== undefined) {
          if (!Array.isArray(document['entries']))
            return [
              ...failures,
              ...validSkills.map(skill => this.report(
                { agent: 'antigravity', skill, kind: 'refused', source: join(sourceRoot, skill), target: manifestPath },
                'Existing ~/.gemini/config/skills.json entries field must be an array',
              )),
            ]
          entries = [...document['entries']]
        }
      }

      const displaySource = process.platform === 'win32' ? sourceRoot.replaceAll('\\', '/') : sourceRoot
      let alreadyCurrent = false
      let repointed = false
      const nextEntries: unknown[] = []
      for (const item of entries) {
        const record = item !== null && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : null
        const entryPath = typeof record?.['path'] === 'string' ? record['path'] : null
        if (entryPath !== null && SkillLinkInstaller.samePath(entryPath, sourceRoot)) {
          if (!alreadyCurrent) {
            alreadyCurrent = true
            nextEntries.push(item)
          }
          continue
        }
        if (entryPath !== null && this.ownedAntigravityRoot(entryPath, receiptBase)) {
          if (!alreadyCurrent && !repointed) {
            repointed = true
            nextEntries.push({ ...record, path: displaySource })
          }
          continue
        }
        nextEntries.push(item)
      }

      let kind: SkillLinkResultKind
      if (alreadyCurrent && !repointed) kind = 'current'
      else if (repointed) kind = 'repointed'
      else {
        kind = 'created'
        nextEntries.push({ path: displaySource })
      }

      if (kind !== 'current' || nextEntries.length !== entries.length) {
        const nextDocument = { ...document, entries: nextEntries }
        const temporary = `${manifestPath}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, `${JSON.stringify(nextDocument, null, 2)}\n`, 'utf8')
          renameSync(temporary, manifestPath)
        } finally {
          if (SkillLinkInstaller.lstat(temporary)) unlinkSync(temporary)
        }
      }
      this.remember(receiptBase, sourceRoot)
      this.cleanupLegacyAntigravityJunctions()

      return [
        ...failures,
        ...validSkills.map(skill => ({
          agent: 'antigravity' as const,
          skill,
          kind,
          source: join(sourceRoot, skill),
          target: manifestPath,
        })),
      ]
    } catch (error) {
      return [
        ...failures,
        ...validSkills.map(skill => this.report(
          { agent: 'antigravity', skill, kind: 'failed', source: join(sourceRoot, skill), target: manifestPath },
          `Skill link could not be installed: ${ErrorText.of(error)}`,
        )),
      ]
    }
  }

  private ownedAntigravityRoot(candidate: string, receiptBase: string): boolean {
    if (this.recordedTarget(receiptBase, candidate)) return true
    const fromSkills = relative(join(this.repoRoot, 'skills'), candidate)
    if (fromSkills !== '' && !fromSkills.startsWith('..') && !isAbsolute(fromSkills)) return true
    return false
  }

  private cleanupLegacyAntigravityJunctions(): void {
    for (const skill of SkillLinkInstaller.skillNamesConst) {
      const target = join(this.antigravityConfigHome, 'skills', skill)
      const stats = SkillLinkInstaller.lstat(target)
      if (stats === null || !stats.isSymbolicLink()) continue
      try {
        const linked = resolve(readlinkSync(target))
        if (!this.ownedTarget(linked, skill, 'antigravity') && !this.recordedTarget(target, linked)) continue
        SkillLinkInstaller.removeLink(target)
        const receipt = this.receipt(target)
        if (SkillLinkInstaller.lstat(receipt)) unlinkSync(receipt)
      } catch { /* best-effort cleanup */ }
    }
  }

  private ownedTarget(target: string, skill: SkillLinkName, agent: SkillLinkAgent): boolean {
    const fromSkills = relative(join(this.repoRoot, 'skills'), target)
    if (fromSkills !== '' && !fromSkills.startsWith('..') && !isAbsolute(fromSkills)) return true
    if (skill === 'appjamat-v3' || skill === 'session-automation-groups') return false
    else if (skill === 'mdext-renderer')
      return this.legacyMdExtTargets(agent).some(candidate => SkillLinkInstaller.samePath(candidate, target))
    else
      throw new Error(`Unknown skill: ${JSON.stringify(skill)}`)
  }

  private receipt(target: string): string {
    return `${target}.jamat-link.json`
  }

  private recordedTarget(target: string, linked: string): boolean {
    try {
      const receipt: unknown = JSON.parse(readFileSync(this.receipt(target), 'utf8'))
      return typeof receipt === 'object' && receipt !== null && 'source' in receipt
        && typeof receipt.source === 'string' && SkillLinkInstaller.samePath(receipt.source, linked)
    } catch { return false }
  }

  private remember(target: string, source: string): void {
    if (this.recordedTarget(target, source)) return
    const receipt = this.receipt(target)
    const temporary = `${receipt}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ source })}\n`, 'utf8')
      renameSync(temporary, receipt)
    } finally {
      if (SkillLinkInstaller.lstat(temporary)) unlinkSync(temporary)
    }
  }

  private legacyMdExtTargets(agent: SkillLinkAgent): readonly string[] {
    const applications = resolve(this.repoRoot, '..')
    return [
      join(applications, 'AppJamat', 'skills', 'mdext-renderer'),
      join(applications, 'AppJamat', 'skills', agent, 'mdext-renderer'),
      join(applications, 'AppJamatV2', 'skills', 'mdext-renderer'),
    ]
  }

  private report(
    result: Omit<SkillLinkResult, 'detail'>,
    detail: string,
  ): SkillLinkResult {
    try { this.deps.report(`${result.agent} ${detail}`) } catch {}
    return { ...result, detail }
  }

  private static lstat(path: string): Stats | null {
    try { return lstatSync(path) } catch { return null }
  }

  private static removeLink(path: string): void {
    try { unlinkSync(path) }
    catch { rmdirSync(path) }
  }

  private static samePath(first: string, second: string): boolean {
    return SkillLinkInstaller.normalize(first) === SkillLinkInstaller.normalize(second)
  }

  private static normalize(path: string): string {
    let normalized: string
    try { normalized = realpathSync.native(path) } catch { normalized = resolve(path) }
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
}
