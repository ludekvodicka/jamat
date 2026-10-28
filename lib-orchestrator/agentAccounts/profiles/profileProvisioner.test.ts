import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileProvisioner } from './profileProvisioner'
import type { AgentProfileSpec } from './profileShareTable'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof fs>()
  return { ...original, symlinkSync: vi.fn(original.symlinkSync) }
})

describe('ProfileProvisioner', () => {
  let root: string
  let main: string
  let home: string
  let provisioner: ProfileProvisioner
  let spec: AgentProfileSpec

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'jamat-profiles-'))
    main = join(root, 'main')
    home = join(root, 'accounts', 'claude', 'second')
    fs.mkdirSync(main)
    fs.mkdirSync(join(main, 'skills'))
    fs.writeFileSync(join(main, 'skills', 'keep.md'), 'main skill')
    fs.writeFileSync(join(main, 'settings.json'), '{"theme":"dark"}')
    spec = {
      agentId: 'claude', mainHome: () => main, homeVariable: 'CLAUDE_CONFIG_DIR',
      extraEnv: () => ({}), loginCommand: 'claude auth login',
      probe: async () => ({ kind: 'logged-out' }),
      shareTable: { directories: ['skills', 'todos'], files: ['settings.json', 'missing.json'], neverShared: ['.credentials.json'] },
    }
    provisioner = new ProfileProvisioner(join(root, 'accounts'))
  })

  afterEach(async () => {
    vi.mocked(fs.symlinkSync).mockReset()
    vi.mocked(fs.symlinkSync).mockImplementation((await vi.importActual<typeof fs>('node:fs')).symlinkSync)
    if (fs.existsSync(home) && !fs.lstatSync(home).isSymbolicLink()) await provisioner.remove(home)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('links directories and present files, creates missing shared directories and writes the manifest last', async () => {
    await provisioner.create(spec, home)
    for (const name of ['skills', 'todos', 'settings.json']) {
      expect(fs.lstatSync(join(home, name)).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(join(home, name))).toBe(fs.realpathSync(join(main, name)))
    }
    expect(fs.existsSync(join(home, 'missing.json'))).toBe(false)
    expect(fs.existsSync(join(main, 'missing.json'))).toBe(false)
    const manifest = JSON.parse(fs.readFileSync(join(home, '.jamat-profile.json'), 'utf8'))
    expect(manifest.links.map((link: { name: string }) => link.name)).toEqual(['skills', 'todos', 'settings.json'])
  })

  it('removes links and private files without changing the main profile', async () => {
    await provisioner.create(spec, home)
    fs.writeFileSync(join(home, '.credentials.json'), 'fixture identity')
    await provisioner.remove(home)
    expect(fs.existsSync(home)).toBe(false)
    expect(fs.readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(fs.readFileSync(join(main, 'skills', 'keep.md'), 'utf8')).toBe('main skill')
  })

  it('scans nested and dangling links when the manifest is missing or malformed', async () => {
    await provisioner.create(spec, home)
    fs.unlinkSync(join(home, '.jamat-profile.json'))
    fs.mkdirSync(join(home, 'private'))
    fs.symlinkSync(join(main, 'skills'), join(home, 'private', 'nested'), 'junction')
    fs.symlinkSync(join(main, 'absent'), join(home, 'dangling'), 'file')
    await provisioner.remove(home)
    expect(fs.readFileSync(join(main, 'skills', 'keep.md'), 'utf8')).toBe('main skill')
  })

  it('never trusts manifest paths and never reads a linked manifest target', async () => {
    await provisioner.create(spec, home)
    fs.writeFileSync(join(home, '.jamat-profile.json'), JSON.stringify({ links: [{ name: '../../main/settings.json' }] }))
    await provisioner.remove(home)
    expect(fs.readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    await provisioner.create(spec, home)
    fs.unlinkSync(join(home, '.jamat-profile.json'))
    fs.symlinkSync(join(main, 'settings.json'), join(home, '.jamat-profile.json'), 'file')
    await provisioner.remove(home)
    expect(fs.readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('refuses paths outside the account root and an account root itself', async () => {
    await expect(provisioner.remove(main)).rejects.toThrow('Profile must be inside')
    await expect(provisioner.remove(join(root, 'accounts'))).rejects.toThrow('Profile must be inside')
    expect(fs.readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('refuses Windows path aliases before they can resolve to another account boundary', async () => {
    await provisioner.create(spec, home)
    for (const name of ['.. ', 'second.', 'second ', 'NUL', 'con.txt'])
      await expect(provisioner.remove(join(root, 'accounts', 'claude', name))).rejects.toThrow('Profile must be inside')
    expect(fs.existsSync(home)).toBe(true)
    expect(fs.readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('refuses a junction at the profile boundary', async () => {
    fs.mkdirSync(join(root, 'accounts', 'claude'), { recursive: true })
    fs.symlinkSync(main, home, 'junction')
    await expect(provisioner.remove(home)).rejects.toThrow('not a real directory')
    fs.unlinkSync(home)
  })

  it('refuses a junction in a parent above the account root', async () => {
    const alias = join(root, 'alias')
    fs.symlinkSync(root, alias, 'junction')
    const throughAlias = new ProfileProvisioner(join(alias, 'accounts'))
    await expect(throughAlias.create(spec, join(alias, 'accounts', 'claude', 'second')))
      .rejects.toThrow('passes through a link')
    expect(fs.existsSync(home)).toBe(false)
    fs.unlinkSync(alias)
  })

  it('rolls back a failed file symlink and reports Developer Mode', async () => {
    vi.mocked(fs.symlinkSync).mockImplementation((target, path, type) => {
      if (type === 'file') throw Object.assign(new Error('denied'), { code: 'EPERM' })
      originalSymlink(target, path, type)
    })
    const originalSymlink = (await vi.importActual<typeof fs>('node:fs')).symlinkSync
    await expect(provisioner.create(spec, home)).rejects.toThrow('Windows Developer Mode is required')
    expect(fs.existsSync(home)).toBe(false)
    expect(fs.readFileSync(join(main, 'skills', 'keep.md'), 'utf8')).toBe('main skill')
  })

  it('repairs a missing junction and preserves a replacement settings file', async () => {
    await provisioner.create(spec, home)
    fs.unlinkSync(join(home, 'skills'))
    fs.unlinkSync(join(home, 'settings.json'))
    fs.writeFileSync(join(home, 'settings.json'), 'local replacement')
    const report = await provisioner.repair(spec, home)
    expect(report.relinked).toEqual(['skills', 'settings.json'])
    const backup = fs.readdirSync(home).find(name => name.startsWith('settings.json.replaced-'))!
    expect(fs.readFileSync(join(home, backup), 'utf8')).toBe('local replacement')
    expect(fs.readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('does not replace an existing profile or accept identity entries and traversal in the table', async () => {
    await provisioner.create(spec, home)
    await expect(provisioner.create(spec, home)).rejects.toThrow('already exists')
    for (const name of ['.credentials.json', '../outside', '.jamat-profile.json'])
      await expect(provisioner.repair({ ...spec, shareTable: { ...spec.shareTable, files: [name] } }, home))
        .rejects.toThrow('Invalid profile share table')
  })
})
