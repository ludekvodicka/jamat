import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { ErrorText } from '../../shared/errorText'

export type SkillLinkAgent = 'claude' | 'codex'
export type SkillLinkName = 'appjamat-v3' | 'mdext-renderer'
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
  report(message: string): void
}

export class SkillLinkInstaller {
  private static readonly skillNamesConst: readonly SkillLinkName[] = [
    'appjamat-v3',
    'mdext-renderer',
  ]
  private readonly repoRoot: string
  private readonly homeRoot: string
  private readonly codexHome: string

  constructor(private readonly deps: SkillLinkInstallerDeps) {
    this.repoRoot = resolve(deps.repoRoot)
    this.homeRoot = resolve(deps.homeRoot)
    this.codexHome = resolve(deps.codexHome ?? join(this.homeRoot, '.codex'))
  }

  install(): readonly SkillLinkResult[] {
    return SkillLinkInstaller.skillNamesConst.flatMap(skill => [
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
        return { agent, skill, kind: 'created', source, target }
      }
      if (!targetStats.isSymbolicLink())
        return this.report(
          { agent, skill, kind: 'refused', source, target },
          'A real file or directory already occupies the skill target',
        )
      const linked = resolve(readlinkSync(target))
      if (SkillLinkInstaller.samePath(linked, source))
        return { agent, skill, kind: 'current', source, target }
      if (!this.ownedTarget(linked, skill, agent))
        return this.report(
          { agent, skill, kind: 'refused', source, target },
          `The existing link points outside ${join(this.repoRoot, 'skills')}`,
        )
      SkillLinkInstaller.removeLink(target)
      symlinkSync(source, target, 'junction')
      return { agent, skill, kind: 'repointed', source, target }
    } catch (error) {
      return this.report(
        { agent, skill, kind: 'failed', source, target },
        `Skill link could not be installed: ${ErrorText.of(error)}`,
      )
    }
  }

  private ownedTarget(target: string, skill: SkillLinkName, agent: SkillLinkAgent): boolean {
    const fromSkills = relative(join(this.repoRoot, 'skills'), target)
    if (fromSkills !== '' && !fromSkills.startsWith('..') && !isAbsolute(fromSkills)) return true
    if (skill === 'appjamat-v3') return false
    else if (skill === 'mdext-renderer')
      return this.legacyMdExtTargets(agent).some(candidate => SkillLinkInstaller.samePath(candidate, target))
    else
      throw new Error(`Unknown skill: ${JSON.stringify(skill)}`)
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
