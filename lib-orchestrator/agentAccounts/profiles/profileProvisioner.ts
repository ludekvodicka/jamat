import { AccountProblem } from '../accountProblem'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { JsonShape } from '../../shared/jsonShape'
import type { AgentProfileSpec, ProfileShareTable } from './profileShareTable'

interface ProfileLink { name: string; kind: 'junction' | 'file-symlink'; target: string }
export interface RepairReport { relinked: readonly string[]; problems: readonly string[] }

export class ProfileProvisioner {
  private readonly accountsRoot: string

  constructor(accountsRoot: string) {
    this.accountsRoot = resolve(accountsRoot)
  }

  async create(spec: AgentProfileSpec, profileHome: string): Promise<void> {
    const home = this.checkedHome(profileHome)
    this.validateTable(spec.shareTable)
    this.checkMain(spec.mainHome(), home)
    if (this.stat(home)) throw new AccountProblem(`Profile already exists: ${home}`)
    fs.mkdirSync(dirname(home), { recursive: true })
    this.checkedHome(home)
    fs.mkdirSync(home)
    try {
      this.linkEntries(spec, home)
    } catch (error) {
      await this.remove(home)
      throw error
    }
  }

  async repair(spec: AgentProfileSpec, profileHome: string): Promise<RepairReport> {
    const home = this.checkedHome(profileHome)
    this.validateTable(spec.shareTable)
    this.checkMain(spec.mainHome(), home)
    if (!this.stat(home)?.isDirectory()) throw new AccountProblem(`Profile does not exist: ${home}`)
    return { relinked: this.linkEntries(spec, home), problems: [] }
  }

  async remove(profileHome: string): Promise<void> {
    const home = this.checkedHome(profileHome)
    if (!this.stat(home)) return
    const manifestPath = join(home, '.jamat-profile.json')
    const manifestStat = this.stat(manifestPath)
    if (manifestStat?.isFile() && !manifestStat.isSymbolicLink()) {
      let manifest: unknown
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
      if (JsonShape.isRecord(manifest) && Array.isArray(manifest.links))
        for (const link of manifest.links)
          if (JsonShape.isRecord(link) && typeof link.name === 'string' && this.safeName(link.name)) {
            const path = join(home, link.name)
            if (this.stat(path)?.isSymbolicLink()) this.unlink(path)
          }
    }
    this.removeLinks(home)
    this.deleteTree(home)
  }

  private linkEntries(spec: AgentProfileSpec, home: string): string[] {
    const main = resolve(spec.mainHome())
    const links: ProfileLink[] = []
    const relinked: string[] = []
    for (const name of spec.shareTable.directories) {
      const target = join(main, name)
      fs.mkdirSync(target, { recursive: true })
      if (!fs.statSync(target).isDirectory()) throw new AccountProblem(`Shared directory is not a directory: ${target}`)
      links.push({ name, kind: 'junction', target })
    }
    for (const name of spec.shareTable.files) {
      const target = join(main, name)
      if (!this.stat(target)) continue
      if (!fs.statSync(target).isFile()) throw new AccountProblem(`Shared file is not a file: ${target}`)
      links.push({ name, kind: 'file-symlink', target })
    }
    for (const link of links) {
      const path = join(home, link.name)
      const current = this.stat(path)
      if (current?.isSymbolicLink()) {
        if (this.samePath(resolve(dirname(path), fs.readlinkSync(path)), link.target)) continue
        this.unlink(path)
      } else if (current)
        fs.renameSync(path, `${path}.replaced-${Date.now()}-${randomUUID()}`)
      try {
        if (link.kind === 'junction') fs.symlinkSync(link.target, path, 'junction')
        else if (link.kind === 'file-symlink') fs.symlinkSync(link.target, path, 'file')
        else throw new AccountProblem(`Unknown profile link kind: ${link.kind}`)
      } catch (error) {
        if (link.kind === 'file-symlink' && ['EPERM', 'EACCES'].includes(ErrnoCode.of(error) ?? ''))
          throw new AccountProblem('Windows Developer Mode is required to share profile files', { cause: error })
        throw error
      }
      relinked.push(link.name)
    }
    const manifest = join(home, '.jamat-profile.json')
    if (this.stat(manifest)?.isSymbolicLink()) throw new AccountProblem('Profile manifest must not be a link')
    AtomicJsonFile.write(manifest, { schemaVersion: 1, agentId: spec.agentId, mainHome: main, links })
    return relinked
  }

  private checkedHome(profileHome: string): string {
    const home = resolve(profileHome)
    const parts = relative(this.accountsRoot, home).split(sep)
    if (parts.length !== 2 || parts.some(part => !this.safeName(part)))
      throw new AccountProblem(`Profile must be inside ${this.accountsRoot}/<agent>/<account>: ${home}`)
    let ancestor = this.accountsRoot
    while (!this.stat(ancestor)) ancestor = dirname(ancestor)
    if (!this.samePath(fs.realpathSync(ancestor), ancestor))
      throw new AccountProblem(`Profile boundary passes through a link: ${ancestor}`)
    for (const path of [this.accountsRoot, dirname(home), home]) {
      const entry = this.stat(path)
      if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
        throw new AccountProblem(`Profile boundary is not a real directory: ${path}`)
    }
    return home
  }

  private checkMain(mainHome: string, profileHome: string): void {
    const main = fs.realpathSync(mainHome)
    const root = resolve(this.accountsRoot)
    const insideMain = relative(main, root)
    const insideRoot = relative(root, main)
    if (this.inside(insideMain) || this.inside(insideRoot) || this.samePath(main, profileHome))
      throw new AccountProblem('Accounts root and main profile must not overlap')
  }

  private inside(path: string): boolean {
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }

  private validateTable(table: ProfileShareTable): void {
    const names = [...table.directories, ...table.files]
    if (names.some(name => !this.safeName(name) || name === '.jamat-profile.json')
      || new Set(names.map(name => name.toLowerCase())).size !== names.length
      || names.some(name => table.neverShared.some(denied => denied.toLowerCase() === name.toLowerCase())))
      throw new AccountProblem('Invalid profile share table')
  }

  private safeName(name: string): boolean {
    return name !== '' && !/[ .]$/.test(name) && !/[\\/:\0<>"|?*]/.test(name)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  }

  private samePath(first: string, second: string): boolean {
    return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second
  }

  private stat(path: string): fs.Stats | null {
    try { return fs.lstatSync(path) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    }
  }

  private unlink(path: string): void {
    try { fs.unlinkSync(path) }
    catch (error) {
      if (process.platform !== 'win32' || !this.stat(path)?.isSymbolicLink()) throw error
      fs.rmdirSync(path)
    }
  }

  private removeLinks(directory: string): void {
    if (this.stat(directory)?.isSymbolicLink()) throw new AccountProblem(`Refusing to follow profile link: ${directory}`)
    for (const name of fs.readdirSync(directory)) {
      const path = join(directory, name)
      const entry = fs.lstatSync(path)
      if (entry.isSymbolicLink()) this.unlink(path)
      else if (entry.isDirectory()) this.removeLinks(path)
    }
  }

  private deleteTree(directory: string): void {
    if (this.stat(directory)?.isSymbolicLink()) throw new AccountProblem(`Profile still holds a link: ${directory}`)
    for (const name of fs.readdirSync(directory)) {
      const path = join(directory, name)
      const entry = fs.lstatSync(path)
      if (entry.isSymbolicLink()) throw new AccountProblem(`Profile still holds a link: ${path}`)
      else if (entry.isDirectory()) this.deleteTree(path)
      else fs.unlinkSync(path)
    }
    fs.rmdirSync(directory)
  }
}
