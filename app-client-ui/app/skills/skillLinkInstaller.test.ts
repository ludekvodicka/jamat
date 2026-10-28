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
import { join } from 'node:path'

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
      for (const agent of ['claude', 'codex']) {
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

  target(agent: 'claude' | 'codex', skill = 'appjamat-v3'): string {
    return agent === 'claude'
      ? join(this.home, '.claude', 'skills', skill)
      : join(this.home, '.codex', 'skills', skill)
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
    expect(new SkillLinkInstaller(deps).roots()).toEqual([join(world.home, '.claude', 'skills'), join(codexHome, 'skills')])
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
    expect(next.map(result => result.kind)).toEqual(Array(6).fill('repointed'))
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

  it('creates all junctions and leaves correct links untouched', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)

    expect(world.installer.install().map((result) => result.kind)).toEqual([
      'created', 'created', 'created', 'created', 'created', 'created',
    ])
    for (const skill of ['appjamat-v3', 'mdext-renderer', 'session-automation-groups'])
      for (const agent of ['claude', 'codex'] as const) {
        expect(lstatSync(world.target(agent, skill)).isSymbolicLink()).toBe(true)
        expect(realpathSync(world.target(agent, skill))).toBe(realpathSync(world.source(agent, skill)))
      }
    expect(world.installer.install().map((result) => result.kind)).toEqual([
      'current', 'current', 'current', 'current', 'current', 'current',
    ])
    expect(world.reports).toEqual([])
  })

  it('repoints an owned wrong junction without touching the other agent', () => {
    const world = new SkillLinkWorld()
    worlds.push(world)
    const target = world.target('claude')
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(world.source('codex'), target, 'junction')

    expect(world.installer.install().map((result) => result.kind)).toEqual([
      'repointed',
      'created',
      'created',
      'created',
      'created',
      'created',
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
      'created',
      'created',
      'created',
      'created',
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
