import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { PathCompare } from '../shared/pathCompare'
import { SvnConflictFacts } from './svnConflictFacts'
import { SvnTextMerge } from './svnTextMerge'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import type { SvnConflictApply, SvnResult, SvnWcItem } from './svn.types'

/** SVN owns conflict metadata. Text choices are installed before SVN can queue any work. */
export class SvnTextResolution {
  /** Another client holds the working copy lock, or its unfinished queue blocks this one. */
  private static readonly foreignLockConst = /\b[EW]155004\b|\bE155037\b/
  /** svn could not open a file its queue installs; the quoted path is followed by the system's reason. */
  private static readonly missingConst = /\bE72000[23]: [^\r\n]*'([^'\r\n]+)':/
  /** Windows' sharing or lock violation on a file svn names: another program holds it open. */
  private static readonly heldConst = /\b[EW]72003[23]: [^\r\n]*'([^'\r\n]+)':/
  private static readonly changedConst = new Set<SvnWcItem>(['added', 'merged', 'modified', 'replaced'])
  private static readonly listedMaxConst = 20
  private readonly svn: CommandRunner
  private readonly changed: ((root: string) => Promise<void>) | undefined

  constructor(svn: CommandRunner, changed?: (root: string) => Promise<void>) {
    this.svn = svn
    this.changed = changed
  }

  async choose(input: SvnConflictApply, side: 'mine' | 'theirs'): Promise<void> {
    const manifest = join(input.savedDir, `text-sides-${createHash('sha256').update(input.path).digest('hex')}.json`)
    const saved = await SvnTextResolution.read(manifest)
    let sides: Record<string, string>
    if (saved === null) {
      const result = await this.svn.run(input.root, ['info', '--xml', '--', `${input.path}@`])
      if (result.code !== 0 || result.failure !== null) throw new Error(result.stderr || result.stdout)
      const facts = SvnConflictFacts.infoConflicts(result.stdout)[0]
      if (!facts?.text || facts.sidecars.theirs === null)
        throw new Error(`No saved text sides for ${input.path}. Inspect the conflict copies at ${input.savedDir}.`)
      // A binary conflict has no .mine: svn leaves the local side as the working file, which save-sidecars copied at the first press.
      sides = { mine: facts.sidecars.mine === null ? input.path : SvnWorktreeEvidence.relativeTo(input.root, facts.sidecars.mine),
        theirs: SvnWorktreeEvidence.relativeTo(input.root, facts.sidecars.theirs) }
      for (const path of Object.values(sides)) {
        const source = SvnTextResolution.inside(input.root, path)
        const destination = SvnTextResolution.inside(input.savedDir, path)
        await mkdir(dirname(destination), { recursive: true })
        if (await SvnTextResolution.read(destination) === null) await copyFile(source, destination)
      }
      await SvnTextResolution.write(manifest, { path: input.path, ...sides })
    } else {
      const data = JSON.parse(saved) as { path?: unknown; mine?: unknown; theirs?: unknown }
      if (data.path !== input.path || typeof data.mine !== 'string' || typeof data.theirs !== 'string')
        throw new Error(`Invalid saved text sides at ${manifest}`)
      sides = { mine: data.mine, theirs: data.theirs }
    }
    const source = SvnTextResolution.inside(input.savedDir, sides[side])
    await this.install(input, (temporary) => copyFile(source, temporary))
  }

  /**
   * Jamat's merge of a text conflict whose sides merge cleanly with line ends ignored, written over
   * svn's markers in the line ends of the incoming side. Nothing to do once svn no longer marks it; a
   * merge that no longer comes out clean refuses, and the conflict stays as svn left it.
   */
  async writeMerged(input: SvnConflictApply): Promise<void> {
    const result = await this.svn.run(input.root, ['info', '--xml', '--', `${input.path}@`])
    if (result.code !== 0 || result.failure !== null) throw new Error(result.stderr || result.stdout)
    const facts = SvnConflictFacts.infoConflicts(result.stdout)[0]
    if (!facts?.text) return
    const { older, mine, theirs } = facts.sidecars
    if (older === null || mine === null || theirs === null) throw new Error(`${input.path} has no three sides to merge`)
    const [before, own, incoming] = await Promise.all([older, mine, theirs]
      .map((path) => readFile(SvnTextResolution.inside(input.root, SvnWorktreeEvidence.relativeTo(input.root, path)))))
    const merged = SvnTextMerge.merge(before, own, incoming)
    if (merged === null) throw new Error(`${input.path} no longer merges cleanly; read the conflicts again`)
    await this.install(input, (temporary) => writeFile(temporary, merged))
  }

  /** The file at `input.path` replaced in one rename by what `fill` writes to a temporary file. */
  private async install(input: SvnConflictApply, fill: (temporary: string) => Promise<void>): Promise<void> {
    const target = SvnTextResolution.inside(input.root, input.path)
    const present = await lstat(target).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
    if (present?.isSymbolicLink() || !PathCompare.isInside(await realpath(input.root), await realpath(present === null ? dirname(target) : target)))
      throw new Error(`Resolve the linked file ${input.path} in an SVN client`)
    // svn cleanup empties .svn/tmp, so a process death here leaves nothing a review could list.
    const temporary = join(await SvnTextResolution.rootOf(input.root, input.path), '.svn', 'tmp', `jamat-${randomUUID()}.tmp`)
    try {
      await mkdir(dirname(temporary), { recursive: true })
      await fill(temporary)
      await rename(temporary, target).catch(async (error: unknown) => {
        if (ErrnoCode.of(error) !== 'EPERM') throw error
        // A writable file Windows refuses to replace is held by another program, as EBUSY says of a copy.
        throw await access(target, constants.W_OK).then(() => Object.assign(new Error(`${input.path} is open in another program`), { code: 'EBUSY', path: target }),
          () => new Error(`${input.path} is read-only (svn:needs-lock); lock it or clear the attribute, then retry`))
      })
      await this.changed?.(input.root)
    } finally { await rm(temporary, { force: true }) }
  }

  static async recoveredChoice(input: Pick<SvnConflictApply, 'root' | 'path' | 'savedDir' | 'kind' | 'journal'>): Promise<'keep-mine' | 'take-incoming' | null> {
    const option = input.journal?.option
    if (input.kind !== 'text' || input.journal === null || input.journal === undefined || input.journal.done < 1
      || option !== 'keep-mine' && option !== 'take-incoming') return null
    const manifest = join(input.savedDir, `text-sides-${createHash('sha256').update(input.path).digest('hex')}.json`)
    const saved = await SvnTextResolution.read(manifest)
    if (saved === null) return null
    let data: { path?: unknown; mine?: unknown; theirs?: unknown }
    try { data = JSON.parse(saved) } catch { return null }
    if (data === null || data.path !== input.path) return null
    const side = option === 'keep-mine' ? data.mine : data.theirs
    if (typeof side !== 'string') return null
    try {
      const working = await readFile(SvnTextResolution.inside(input.root, input.path))
      const selected = await readFile(SvnTextResolution.inside(input.savedDir, side))
      return working.equals(selected) ? option : null
    } catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return null
      throw error
    }
  }

  async resolve(root: string, path: string): Promise<SvnResult<string>> {
    const wc = await SvnTextResolution.rootOf(root, path)
    const marker = join(wc, '.svn', 'jamat-text-resolution.json')
    const before = await SvnTextResolution.database(wc)
    // A process death before the result is saved leaves an untrusted marker, never a cleanup permit.
    await SvnTextResolution.write(marker, { version: 1, database: null })
    const result = await this.svn.run(root, ['resolve', '--non-interactive', '--accept', 'working', '--', `${path}@`])
    const after = await SvnTextResolution.database(wc)
    // Only a resolve that wrote the database itself, past no lock of another client, owns the queue it left.
    const own = after !== before && !SvnTextResolution.foreignLockConst.test(`${result.stdout}\n${result.stderr}`)
    await SvnTextResolution.write(marker, { version: 1, database: own ? after : null })
    return result.code === 0 && result.failure === null ? { ok: true, value: result.stdout }
      : { ok: false, code: 'svn-failed', detail: result.stderr || result.stdout }
  }

  /** A queue Jamat cannot prove its own gets no cleanup; the changed files are copied below `savedDir` instead. */
  async recover(root: string, paths: readonly string[], savedDir: string, at: number): Promise<SvnResult<void>> {
    const roots = [...new Set(await Promise.all(paths.map((path) => SvnTextResolution.rootOf(root, path))))]
    for (const wc of roots) {
      const marker = join(wc, '.svn', 'jamat-text-resolution.json')
      const saved = await SvnTextResolution.read(marker)
      let data: { version?: unknown; database?: unknown } | null = null
      try { data = saved === null ? null : JSON.parse(saved) } catch {}
      if (data?.version !== 1 || typeof data.database !== 'string' || data.database !== await SvnTextResolution.database(wc)) {
        const copies = join(savedDir, `locked-${new Date(at).toISOString().replace(/[:.]/g, '-')}`)
        return { ok: false, code: 'locked', detail: `SVN is locked at ${wc} by an operation Jamat cannot prove it started; no cleanup was attempted. `
          + `${await this.preserved(root, wc, copies)} Stop other SVN clients, run Cleanup on ${wc} in TortoiseSVN, compare the files with the copies, `
          + 'restore what you want, then press Check again.' }
      }
      const cleaned = await this.svn.run(wc, ['cleanup', '--non-interactive', '--', '.'])
      await SvnTextResolution.write(marker, { version: 1, database: await SvnTextResolution.database(wc) })
      const missing = SvnTextResolution.missingConst.exec(`${cleaned.stderr}\n${cleaned.stdout}`)
      if (cleaned.code !== 0 || cleaned.failure !== null) {
        const held = SvnTextResolution.heldIn(root, `${cleaned.stderr}\n${cleaned.stdout}`)
        return { ok: false, code: 'locked', detail: missing === null
          ? `${held === null ? 'Jamat could not finish its own interrupted SVN step, so' : `${held} is open in another program, so Jamat could not finish its own interrupted SVN step and`} `
            + `the working copy ${wc} stays locked. Close ${held === null ? 'any program that holds one of its files' : 'that program'}, `
            + 'then choose the option again or press Check again. Your working files were left as they are.'
          : `The working file ${SvnWorktreeEvidence.relativeTo(root, missing[1])} is missing, and SVN must install it to finish the settlement. `
            + `Put the version you want there (the saved sides are in ${savedDir}), then press Check again.` }
      }
      await rm(marker, { force: true })
    }
    return { ok: true, value: undefined }
  }

  /**
   * Copies of every changed or conflicted file of the working copy and of the files named after it
   * (its conflict sidecars), made before a person runs a cleanup that may install over them.
   */
  private async preserved(root: string, wc: string, copies: string): Promise<string> {
    const status = await this.svn.run(wc, ['status', '--xml', '--non-interactive', '--ignore-externals', '--', '.'])
    if (status.code !== 0 || status.failure !== null)
      return `Jamat could not list the changed files (${(status.stderr || status.stdout).trim()}); copy them yourself before the cleanup.`
    const files = new Set<string>()
    for (const row of SvnConflictFacts.itemRows(status.stdout, wc)) {
      if (row.path === '.' || !row.conflict && !SvnTextResolution.changedConst.has(row.item)) continue
      const file = join(wc, ...row.path.split('/'))
      const siblings = await readdir(dirname(file)).catch(() => [])
      for (const name of [basename(file), ...siblings.filter((name) => name.startsWith(`${basename(file)}.`))]) files.add(join(dirname(file), name))
    }
    const copied: string[] = [], failed: string[] = []
    for (const file of files) {
      if ((await lstat(file).catch(() => null))?.isFile() !== true) continue
      const path = SvnWorktreeEvidence.relativeTo(root, file)
      try {
        await mkdir(dirname(join(copies, path)), { recursive: true })
        await copyFile(file, join(copies, path), constants.COPYFILE_EXCL)
        copied.push(path)
      } catch { failed.push(path) }
    }
    return [
      copied.length === 0 && failed.length === 0 ? 'No changed file needed a copy.' : '',
      copied.length === 0 ? '' : `Copies of the current files are in ${copies}: ${SvnTextResolution.listed(copied)}.`,
      failed.length === 0 ? '' : `Jamat could not copy ${SvnTextResolution.listed(failed)}; copy them yourself before the cleanup.`,
    ].filter(Boolean).join(' ')
  }

  /** The file svn's output says another program holds, relative to `root` when inside it; null when it names none. */
  static heldIn(root: string, output: string): string | null {
    const held = SvnTextResolution.heldConst.exec(output)?.[1]
    if (held === undefined) return null
    return PathCompare.isInside(root, held) ? SvnWorktreeEvidence.relativeTo(root, held) : held
  }

  private static listed(paths: readonly string[]): string {
    const more = paths.length - SvnTextResolution.listedMaxConst
    return `${paths.slice(0, SvnTextResolution.listedMaxConst).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  }

  private static inside(root: string, path: string): string {
    const target = join(root, path)
    if (!PathCompare.isInside(root, target)) throw new Error(`Text resolution path leaves its root: ${path}`)
    return target
  }

  static async rootOf(root: string, path: string): Promise<string> {
    let candidate = SvnTextResolution.inside(root, path)
    while (PathCompare.isInside(root, candidate)) {
      if (await lstat(join(candidate, '.svn', 'wc.db')).catch(() => null)) return candidate
      const parent = dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
    throw new Error(`No SVN working copy for ${path} in ${root}`)
  }

  private static async database(root: string): Promise<string> {
    const hash = createHash('sha256')
    for (const file of ['wc.db', 'wc.db-wal']) {
      const content = await readFile(join(root, '.svn', file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0)
        throw error
      })
      hash.update(file).update(String(content.length)).update(content)
    }
    return hash.digest('hex')
  }

  private static async read(file: string): Promise<string | null> {
    return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  }

  private static async write(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try { await writeFile(temporary, JSON.stringify(value), { flush: true }); await rename(temporary, file) }
    finally { await rm(temporary, { force: true }) }
  }
}
