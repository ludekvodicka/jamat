import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type TreeRemovalEntry, type TreeRemovalFs, type TreeRemovalProgress, TreeRemoval } from './treeRemoval'

describe('lib-orchestrator/shared/treeRemoval', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function temporary(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-tree-removal-'))
    created.push(root)
    return root
  }

  /** A tree in memory: a path maps to its children, a file or a link to null. */
  class FakeFs implements TreeRemovalFs {
    readonly calls: string[] = []
    readonly rmCalls: { path: string; options: typeof TreeRemoval.rmOptionsConst }[] = []
    readonly nodes = new Map<string, 'directory' | 'file' | 'link'>()
    /** Directories an `rm` met while they still held a child directory. */
    readonly removedBeforeChildren: string[] = []
    failReaddir: string | null = null
    failRm: string | null = null
    /** With a delay every rm and readdir waits that long, so calls overlap. */
    delayMilliseconds = 0
    active = 0
    maxActive = 0

    constructor(paths: Record<string, 'directory' | 'file' | 'link'>) {
      for (const [path, kind] of Object.entries(paths)) this.nodes.set(path, kind)
    }

    async rm(path: string, options: typeof TreeRemoval.rmOptionsConst): Promise<void> {
      this.calls.push(`rm ${path}`)
      this.rmCalls.push({ path, options })
      await this.busy()
      if (path === this.failRm) throw new Error('EBUSY')
      const below = [...this.nodes.keys()].filter((node) => node.startsWith(`${path}\\`))
      if (below.some((node) => this.nodes.get(node) === 'directory')) this.removedBeforeChildren.push(path)
      for (const node of [...below, path]) this.nodes.delete(node)
    }

    async readdir(path: string): Promise<TreeRemovalEntry[]> {
      this.calls.push(`readdir ${path}`)
      await this.busy()
      if (path === this.failReaddir) throw new Error('EACCES')
      const children = [...this.nodes.entries()].filter(([node]) => node.startsWith(`${path}\\`) && !node.slice(path.length + 1).includes('\\'))
      return children.map(([node, kind]) => ({
        name: node.slice(path.length + 1),
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => kind === 'link',
      }))
    }

    private async busy(): Promise<void> {
      this.active += 1
      this.maxActive = Math.max(this.maxActive, this.active)
      if (this.delayMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds))
      this.active -= 1
    }

    lstat(path: string): Promise<Pick<TreeRemovalEntry, 'isDirectory' | 'isSymbolicLink'>> {
      this.calls.push(`lstat ${path}`)
      const kind = this.nodes.get(path)
      if (kind === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'link' })
    }
  }

  const treeConst = {
    'C:\\t': 'directory',
    'C:\\t\\a.txt': 'file',
    'C:\\t\\link': 'link',
    'C:\\t\\src': 'directory',
    'C:\\t\\src\\b.txt': 'file',
    'C:\\t\\src\\deep': 'directory',
    'C:\\t\\src\\deep\\c.txt': 'file',
    'C:\\t\\src\\deep\\d.txt': 'file',
    'C:\\t\\empty': 'directory',
  } as const

  it('makes exactly one rm of the path without a listener', async () => {
    const fs = new FakeFs(treeConst)

    await TreeRemoval.over(fs)('C:\\t')

    expect(fs.calls).toEqual(['rm C:\\t'])
    expect(fs.rmCalls[0].options).toBe(TreeRemoval.rmOptionsConst)
  })

  it('counts with a growing done and no total, then deletes every child directory before its parent up to done === total', async () => {
    const fs = new FakeFs(treeConst)
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.over(fs)('C:\\t', (progress) => seen.push(progress))

    expect(fs.nodes.size).toBe(0)
    expect(fs.removedBeforeChildren).toEqual([])
    const rms = fs.calls.filter((call) => call.startsWith('rm '))
    expect(rms.indexOf('rm C:\\t\\src\\deep')).toBeLessThan(rms.indexOf('rm C:\\t\\src'))
    expect(rms.indexOf('rm C:\\t\\src')).toBeLessThan(rms.indexOf('rm C:\\t'))
    expect(rms.indexOf('rm C:\\t\\empty')).toBeLessThan(rms.indexOf('rm C:\\t'))
    expect(rms.at(-1)).toBe('rm C:\\t')
    // The link is one file of its parent and is never read.
    expect(fs.calls).not.toContain('readdir C:\\t\\link')
    const counting = seen.filter((progress) => progress.phase === 'counting')
    expect(counting.every((progress) => progress.total === null)).toBe(true)
    expect(counting.map((progress) => progress.done)).toEqual([...counting.map((progress) => progress.done)].sort((a, b) => a - b))
    expect(counting.at(-1)?.done).toBe(5)
    const deleting = seen.filter((progress) => progress.phase === 'deleting')
    expect(deleting.every((progress) => progress.total === 5)).toBe(true)
    expect(deleting.at(-1)).toEqual({ phase: 'deleting', done: 5, total: 5 })
    const phases = seen.map((progress) => progress.phase)
    expect(phases.indexOf('deleting')).toBe(phases.lastIndexOf('counting') + 1)
  })

  it('runs at most parallelConst calls at a time and still removes each directory only after the ones below it', async () => {
    const paths: Record<string, 'directory' | 'file' | 'link'> = { 'C:\\w': 'directory' }
    for (let top = 0; top < 12; top += 1) {
      paths[`C:\\w\\p${top}`] = 'directory'
      paths[`C:\\w\\p${top}\\f.js`] = 'file'
      for (let inner = 0; inner < 3; inner += 1) {
        paths[`C:\\w\\p${top}\\d${inner}`] = 'directory'
        paths[`C:\\w\\p${top}\\d${inner}\\g.js`] = 'file'
      }
    }
    const fs = new FakeFs(paths)
    fs.delayMilliseconds = 2
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.over(fs)('C:\\w', (progress) => seen.push(progress))

    expect(fs.nodes.size).toBe(0)
    expect(fs.removedBeforeChildren).toEqual([])
    expect(fs.maxActive).toBeGreaterThan(1)
    expect(fs.maxActive).toBeLessThanOrEqual(TreeRemoval.parallelConst)
    expect(TreeRemoval.parallelConst).toBe(8)
    expect(fs.calls.filter((call) => call.startsWith('rm ')).at(-1)).toBe('rm C:\\w')
    const deleting = seen.filter((progress) => progress.phase === 'deleting')
    expect(deleting.map((progress) => progress.done)).toEqual([...deleting.map((progress) => progress.done)].sort((a, b) => a - b))
    expect(deleting.at(-1)).toEqual({ phase: 'deleting', done: 48, total: 48 })
  })

  it('starts no rm after one failed, lets those in flight end, and throws that failure', async () => {
    const fs = new FakeFs(treeConst)
    fs.failRm = 'C:\\t\\src\\deep'
    const seen: TreeRemovalProgress[] = []

    await expect(TreeRemoval.over(fs)('C:\\t', (progress) => seen.push(progress))).rejects.toThrow('EBUSY')

    expect(fs.calls).not.toContain('rm C:\\t\\src')
    expect(fs.calls).not.toContain('rm C:\\t')
    expect(fs.nodes.has('C:\\t\\src\\deep')).toBe(true)
    expect(seen.some((progress) => progress.phase === 'deleting' && progress.done === progress.total)).toBe(false)
  })

  it('says which file is held while it retries a held directory, then goes on once the holder lets go (UA1-J11-6)', async () => {
    const fs = new FakeFs(treeConst)
    let refusals = 2
    const rm = fs.rm.bind(fs)
    fs.rm = async (path, options) => {
      if (path === 'C:\\t\\src\\deep' && refusals > 0) {
        refusals -= 1
        fs.calls.push(`rm ${path}`)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: 'C:\\t\\src\\deep\\c.txt' })
      }
      return rm(path, options)
    }
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.over(fs, { attempts: 4, delayMilliseconds: 1 })('C:\\t', (progress) => seen.push(progress))

    expect(fs.nodes.size).toBe(0)
    const held = seen.filter((progress) => progress.held !== undefined)
    expect(held.map((progress) => progress.held)).toEqual([
      { path: 'C:\\t\\src\\deep\\c.txt', code: 'EBUSY', attempt: 1, attempts: 4, delayMilliseconds: 1 },
      { path: 'C:\\t\\src\\deep\\c.txt', code: 'EBUSY', attempt: 2, attempts: 4, delayMilliseconds: 1 },
    ])
    expect(held.every((progress) => progress.phase === 'deleting' && progress.total === 5)).toBe(true)
    expect(seen.at(-1)).toEqual({ phase: 'deleting', done: 5, total: 5 })
  })

  it('gives up on a file still held after the last try and throws its error', async () => {
    const fs = new FakeFs(treeConst)
    const rm = fs.rm.bind(fs)
    fs.rm = async (path, options) => {
      if (path === 'C:\\t\\src\\deep') throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM', path: 'C:\\t\\src\\deep\\d.txt' })
      return rm(path, options)
    }
    const seen: TreeRemovalProgress[] = []

    await expect(TreeRemoval.over(fs, { attempts: 3, delayMilliseconds: 1 })('C:\\t', (progress) => seen.push(progress))).rejects.toThrow('EPERM')

    expect(seen.filter((progress) => progress.held !== undefined).map((progress) => progress.held?.attempt)).toEqual([1, 2])
    expect(fs.nodes.has('C:\\t\\src\\deep\\d.txt')).toBe(true)
    expect(TreeRemoval.heldPolicyConst.attempts * TreeRemoval.heldPolicyConst.delayMilliseconds).toBeLessThanOrEqual(60_000)
  })

  it('unlinks a link root or a file root with one rm and no walk, as one of one', async () => {
    for (const kind of ['link', 'file'] as const) {
      const fs = new FakeFs({ 'C:\\root': kind })
      const seen: TreeRemovalProgress[] = []

      await TreeRemoval.over(fs)('C:\\root', (progress) => seen.push(progress))

      expect(fs.calls).toEqual(['lstat C:\\root', 'rm C:\\root'])
      expect(seen).toEqual([{ phase: 'deleting', done: 1, total: 1 }])
    }
  })

  it.runIf(process.platform === 'win32')('unlinks a junction root and leaves its whole target on disk', async () => {
    const root = temporary()
    const target = join(root, 'target')
    mkdirSync(join(target, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(target, 'kept.txt'), 'kept')
    writeFileSync(join(target, 'nested', 'deeper', 'deep.txt'), 'deep')
    const junction = join(root, 'junction')
    symlinkSync(target, junction, 'junction')
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.node(junction, (progress) => seen.push(progress))

    expect(existsSync(junction)).toBe(false)
    expect(readdirSync(target).sort()).toEqual(['kept.txt', 'nested'])
    expect(readdirSync(join(target, 'nested', 'deeper'))).toEqual(['deep.txt'])
    expect(seen).toEqual([{ phase: 'deleting', done: 1, total: 1 }])
  })

  it('falls back to one rm of the root, without a count, when the walk cannot read a directory', async () => {
    const fs = new FakeFs(treeConst)
    fs.failReaddir = 'C:\\t\\src\\deep'
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.over(fs)('C:\\t', (progress) => seen.push(progress))

    expect(fs.calls.filter((call) => call.startsWith('rm '))).toEqual(['rm C:\\t'])
    expect(seen.at(-1)).toEqual({ phase: 'deleting', done: 0, total: null })
  })

  it.runIf(process.platform === 'win32')('removes a real tree on disk and leaves the targets of its junction and its file symlink whole', async () => {
    const root = temporary()
    const outside = join(root, 'outside')
    mkdirSync(join(outside, 'store'), { recursive: true })
    writeFileSync(join(outside, 'store', 'kept.txt'), 'kept')
    writeFileSync(join(outside, 'single.txt'), 'single')
    const tree = join(root, 'tree')
    mkdirSync(join(tree, 'node_modules', 'pkg'), { recursive: true })
    for (let index = 0; index < 20; index += 1) writeFileSync(join(tree, 'node_modules', 'pkg', `f${index}.js`), 'x')
    writeFileSync(join(tree, 'top.txt'), 'x')
    symlinkSync(join(outside, 'store'), join(tree, 'node_modules', 'linked'), 'junction')
    symlinkSync(join(outside, 'single.txt'), join(tree, 'single-link.txt'), 'file')
    const seen: TreeRemovalProgress[] = []

    await TreeRemoval.node(tree, (progress) => seen.push(progress))

    expect(existsSync(tree)).toBe(false)
    expect(readdirSync(join(outside, 'store'))).toEqual(['kept.txt'])
    expect(existsSync(join(outside, 'single.txt'))).toBe(true)
    // 20 package files, the top file, the junction and the file symlink.
    expect(seen.at(-1)).toEqual({ phase: 'deleting', done: 23, total: 23 })
  })

  it('takes a path that is already gone as removed, with or without a listener', async () => {
    const gone = join(temporary(), 'gone')

    await expect(TreeRemoval.node(gone)).resolves.toBeUndefined()
    const seen: TreeRemovalProgress[] = []
    await expect(TreeRemoval.node(gone, (progress) => seen.push(progress))).resolves.toBeUndefined()
    expect(seen).toEqual([{ phase: 'deleting', done: 0, total: null }])
  })
})
