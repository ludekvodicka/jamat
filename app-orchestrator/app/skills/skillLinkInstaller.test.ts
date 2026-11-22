import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SkillLinkInstaller } from './skillLinkInstaller'

class SkillLinkWorld {
  readonly root = mkdtempSync(join(tmpdir(), 'jamat-v3-skill-links-'))
  readonly repo = join(this.root, 'repo')
  readonly home = join(this.root, 'home')
  readonly reports: string[] = []
  readonly installer: SkillLinkInstaller

  constructor() {
    for (const skill of ['appjamat-v3', 'mdext-renderer', 'session-automation-groups'])
      for (const agent of ['claude', 'codex', 'antigravity']) {
        const source = this.source(agent, skill)
        mkdirSync(source, { recursive: true })
        writeFileSync(join(source, 'SKILL.md'), agent, 'utf8')
      }
    this.installer = new SkillLinkInstaller({
      repoRoot: this.repo,
      homeRoot: this.home,
      report: (message) => this.reports.push(message),
    })
  }

  source(agent: string, skill = 'appjamat-v3'): string {
    return join(this.repo, 'skills', agent, skill)
  }

  target(agent: 'claude' | 'codex' | 'antigravity', skill = 'appjamat-v3'): string {
    if (agent === 'claude') return join(this.home, '.claude', 'skills', skill)
    else if (agent === 'codex') return join(this.home, '.codex', 'skills', skill)
    else return join(this.home, '.gemini', 'config', 'skills', skill)
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

describe('app-client-ui/app/skills/skillLinkInstaller', () => {
  const worlds: SkillLinkWorld[] = []

  afterEach(() => {
    for (const world of worlds.splice(0)) world.cleanup()
  })

  it.each(['Q:/x/.worktrees/043/Jamat', 'Q:\\x\\.worktrees\\043\\Jamat'])(
    'skips all links from the worktree checkout %s', repoRoot => {
      const world = new SkillLinkWorld()
      worlds.push(world)
      const installer = new SkillLinkInstaller({ repoRoot, homeRoot: world.home, report: () => {} })
      expect(installer.skipReason()).toBe('worktree checkout')
      expect(installer.install()).toEqual([])
      expect(existsSync(world.home)).toBe(false)
    },
  )

  it('skips all links for an instance with a private state root', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const installer = new SkillLinkInstaller({ repoRoot: world.repo, homeRoot: world.home, privateStateRoot: true, report: () => {} })
    expect(installer.skipReason()).toBe('private state root')
    expect(installer.install()).toEqual([])
    expect(existsSync(world.home)).toBe(false)
  })

  // A subst drive such as X:\base mapped onto Q:\Jamat\.worktrees\043 hides the folder from the path itself.
  it('skips all links from a worktree checkout reached through a drive alias', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const realpaths: string[] = []
    const installer = new SkillLinkInstaller({ repoRoot: 'X:\\base', homeRoot: world.home, report: () => {},
      realpath: (path) => { realpaths.push(path); return 'D:\\work\\Jamat\\.worktrees\\043-measure' } })
    expect(installer.skipReason()).toBe('worktree checkout')
    expect(installer.install()).toEqual([])
    expect(realpaths).toEqual([resolve('X:\\base'), resolve('X:\\base')])
    expect(existsSync(world.home)).toBe(false)
  })

  it('installs from the main copy with the default state root', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const installer = new SkillLinkInstaller({ repoRoot: world.repo, homeRoot: world.home, privateStateRoot: false, report: () => {},
      realpath: (path) => path })
    expect(installer.skipReason()).toBeNull()
    expect(installer.install().map((result) => result.kind)).toEqual(Array(9).fill('created'))
    expect(lstatSync(world.target('claude')).isSymbolicLink()).toBe(true)
    const manifest = JSON.parse(readFileSync(join(world.home, '.gemini', 'config', 'skills.json'), 'utf8')) as {
      entries: Array<{ path: string }>
    }
    expect(manifest.entries).toHaveLength(1)
    expect(realpathSync(manifest.entries[0]!.path)).toBe(realpathSync(join(world.repo, 'skills', 'antigravity')))
  })

  it('skips all links when the environment opt-out is supplied', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const installer = new SkillLinkInstaller({ repoRoot: world.repo, homeRoot: world.home, skip: true, report: () => {} })
    expect(installer.skipReason()).toBe('JAMAT_V3_SKIP_SKILL_LINKS=1')
    expect(installer.install()).toEqual([])
    expect(existsSync(world.home)).toBe(false)
  })

  it('repoints a receipt-owned link whose previous worktree target has disappeared', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const target = world.target('claude')
    const stale = join(world.root, '.worktrees', '043', 'Jamat', 'skills', 'claude', 'appjamat-v3')
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(stale, target, 'junction')
    writeFileSync(`${target}.jamat-link.json`, JSON.stringify({ source: stale }))
    expect(world.installer.skipReason()).toBeNull()
    expect(world.installer.install()[0]?.kind).toBe('repointed')
    expect(realpathSync(target)).toBe(realpathSync(world.source('claude')))
  })

  it('installs automation for a custom Codex home and safely follows the next packaged release', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const codexHome = join(world.root, 'custom-codex')
    const deps = { repoRoot: world.repo, homeRoot: world.home, codexHome, report: () => {} }
    expect(new SkillLinkInstaller(deps).roots()).toEqual([
      join(world.home, '.claude', 'skills'),
      join(codexHome, 'skills'),
      join(world.home, '.gemini', 'config', 'skills'),
    ])
    const initial = new SkillLinkInstaller(deps).install()
    const target = join(codexHome, 'skills', 'session-automation-groups')
    expect(initial.find(result => result.target === target)?.kind).toBe('created')
    const nextRoot = join(world.root, 'next-release', 'resources')
    for (const result of initial) {
      const source = join(nextRoot, 'skills', result.agent, result.skill)
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'SKILL.md'), 'new release')
    }
    const next = new SkillLinkInstaller({ ...deps, repoRoot: nextRoot }).install()
    expect(next.map(result => result.kind)).toEqual(Array(9).fill('repointed'))
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new release')
  })

  it('does not replace an automation link repointed by its owner after installation', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const target = world.target('codex', 'session-automation-groups')
    world.installer.install()
    const foreign = join(world.root, 'custom-automation')
    mkdirSync(foreign)
    rmSync(target)
    symlinkSync(foreign, target, 'junction')
    expect(world.installer.install().find(result => result.target === target)?.kind).toBe('refused')
    expect(realpathSync(target)).toBe(realpathSync(foreign))
  })

  it('creates all links, registers Antigravity in skills.json, and leaves correct installs untouched', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)

    expect(world.installer.install().map((result) => result.kind)).toEqual(Array(9).fill('created'))
    for (const skill of ['appjamat-v3', 'mdext-renderer', 'session-automation-groups'])
      for (const agent of ['claude', 'codex'] as const) {
        expect(lstatSync(world.target(agent, skill)).isSymbolicLink()).toBe(true)
        expect(realpathSync(world.target(agent, skill))).toBe(realpathSync(world.source(agent, skill)))
      }
    const manifestPath = join(world.home, '.gemini', 'config', 'skills.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Array<{ path: string }> }
    expect(manifest.entries).toHaveLength(1)
    expect(realpathSync(manifest.entries[0]!.path)).toBe(realpathSync(join(world.repo, 'skills', 'antigravity')))
    expect(world.installer.install().map((result) => result.kind)).toEqual(Array(9).fill('current'))
    expect(world.reports).toEqual([])
  })

  it('preserves user entries in ~/.gemini/config/skills.json and removes legacy Antigravity junctions', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const configDir = join(world.home, '.gemini', 'config')
    const legacyTarget = world.target('antigravity', 'appjamat-v3')
    mkdirSync(join(legacyTarget, '..'), { recursive: true })
    symlinkSync(world.source('antigravity', 'appjamat-v3'), legacyTarget, 'junction')
    writeFileSync(`${legacyTarget}.jamat-link.json`, JSON.stringify({ source: world.source('antigravity', 'appjamat-v3') }))
    writeFileSync(join(configDir, 'skills.json'), JSON.stringify({
      inherits: [{ path: 'Q:/Tooling/agent_extensions/skills.json' }],
      entries: [{ path: 'Q:/Tooling/agent_extensions/skills-antigravity' }],
    }), 'utf8')

    expect(world.installer.install().filter(r => r.agent === 'antigravity').map(r => r.kind))
      .toEqual(['created', 'created', 'created'])
    expect(existsSync(legacyTarget)).toBe(false)
    expect(existsSync(`${legacyTarget}.jamat-link.json`)).toBe(false)
    const manifest = JSON.parse(readFileSync(join(configDir, 'skills.json'), 'utf8')) as {
      inherits: Array<{ path: string }>
      entries: Array<{ path: string }>
    }
    expect(manifest.inherits).toEqual([{ path: 'Q:/Tooling/agent_extensions/skills.json' }])
    expect(manifest.entries).toHaveLength(2)
    expect(manifest.entries[0]!.path).toBe('Q:/Tooling/agent_extensions/skills-antigravity')
    expect(realpathSync(manifest.entries[1]!.path)).toBe(realpathSync(join(world.repo, 'skills', 'antigravity')))
  })

  it('repoints an owned wrong junction without touching the other agent', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const target = world.target('claude')
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(world.source('codex'), target, 'junction')

    expect(world.installer.install().map((result) => result.kind)).toEqual([
      'repointed',
      ...Array(8).fill('created'),
    ])
    expect(realpathSync(target)).toBe(realpathSync(world.source('claude')))
  })

  it('replaces its broken junction and refuses a real user directory', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const stale = join(world.repo, 'skills', 'stale', 'appjamat-v3')
    mkdirSync(stale, { recursive: true })
    const claudeTarget = world.target('claude')
    mkdirSync(join(claudeTarget, '..'), { recursive: true })
    symlinkSync(stale, claudeTarget, 'junction')
    rmSync(stale, { recursive: true, force: true })
    const codexTarget = world.target('codex')
    mkdirSync(codexTarget, { recursive: true })
    writeFileSync(join(codexTarget, 'keep.txt'), 'mine', 'utf8')

    expect(world.installer.install().map((result) => result.kind)).toEqual([
      'repointed',
      'refused',
      ...Array(7).fill('created'),
    ])
    expect(realpathSync(claudeTarget)).toBe(realpathSync(world.source('claude')))
    expect(existsSync(join(codexTarget, 'keep.txt'))).toBe(true)
    expect(readFileSync(join(codexTarget, 'keep.txt'), 'utf8')).toBe('mine')
    expect(world.reports).toHaveLength(1)
  })

  it('refuses a foreign junction and leaves it pointed at its owner', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const foreign = join(world.root, 'foreign-skill')
    mkdirSync(foreign, { recursive: true })
    const target = world.target('claude')
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(foreign, target, 'junction')

    expect(world.installer.install()[0]).toMatchObject({ kind: 'refused' })
    expect(realpathSync(target)).toBe(realpathSync(foreign))
  })

  it('repoints the exact AppJamat MdExt junctions during consolidation', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    for (const agent of ['claude', 'codex'] as const) {
      const legacy = join(world.repo, '..', 'AppJamat', 'skills', agent, 'mdext-renderer')
      mkdirSync(legacy, { recursive: true })
      const target = world.target(agent, 'mdext-renderer')
      mkdirSync(join(target, '..'), { recursive: true })
      symlinkSync(legacy, target, 'junction')
    }

    expect(world.installer.install().slice(2, 4).map((result) => result.kind)).toEqual([
      'repointed',
      'repointed',
    ])
    for (const agent of ['claude', 'codex'] as const)
      expect(realpathSync(world.target(agent, 'mdext-renderer')))
        .toBe(realpathSync(world.source(agent, 'mdext-renderer')))
  })
})
