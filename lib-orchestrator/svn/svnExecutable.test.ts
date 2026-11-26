import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { SvnCommitManager } from './svnCommitManager'
import { SvnExecutable } from './svnExecutable'
import { SvnInvoker } from './svnInvoker'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

describe('lib-orchestrator/svn/svnExecutable', () => {
  const roots: string[] = []
  afterEach(async () => {
    SvnExecutable.clearCache()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('recognizes Windows builds that support activeCodePage UTF-8', () => {
    expect(SvnExecutable.supportsActiveCodePage('10.0.18362')).toBe(true)
    expect(SvnExecutable.supportsActiveCodePage('10.0.26300')).toBe(true)
    expect(SvnExecutable.supportsActiveCodePage('11.0.0')).toBe(true)
    expect(SvnExecutable.supportsActiveCodePage('10.0.17763')).toBe(false)
    expect(SvnExecutable.supportsActiveCodePage('6.3.9600')).toBe(false)
  })

  it('merges activeCodePage UTF-8 into existing manifests and preserves trustInfo and compatibility', () => {
    const tsvn = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo/><compatibility/></assembly>'
    const merged = SvnExecutable.mergeUtf8Manifest(tsvn)
    expect(merged).toContain('<trustInfo/>')
    expect(merged).toContain('<compatibility/>')
    expect(SvnExecutable.hasUtf8ActiveCodePage(merged)).toBe(true)

    const withSettings = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1"><application><windowsSettings><dpiAware>true</dpiAware></windowsSettings></application></assembly>'
    const mergedSettings = SvnExecutable.mergeUtf8Manifest(withSettings)
    expect(mergedSettings).toContain('<dpiAware>true</dpiAware>')
    expect(mergedSettings.match(/<windowsSettings>/g)).toHaveLength(1)
    expect(SvnExecutable.hasUtf8ActiveCodePage(mergedSettings)).toBe(true)

    expect(SvnExecutable.hasUtf8ActiveCodePage(SvnExecutable.mergeUtf8Manifest(null))).toBe(true)
    expect(SvnExecutable.mergeUtf8Manifest(`\uFEFF${merged}`)).toBe(merged)
  })

  it('rejects non-PE files cleanly and preserves PATH casing when prepending DLL directories', () => {
    expect(SvnExecutable.stripEmbeddedManifest(Buffer.from('not a pe')).validPe).toBe(false)
    expect(SvnExecutable.dllPathOverride({ Path: 'C:\\Windows' }, 'C:\\SVN\\bin')).toEqual({ Path: 'C:\\SVN\\bin;C:\\Windows' })
    expect(SvnExecutable.dllPathOverride({ Path: 'C:\\SVN\\bin;C:\\Windows' }, 'C:\\svn\\bin')).toEqual({})
    expect(SvnExecutable.dllPathOverride({ PATH: 'C:\\Windows' }, null)).toEqual({})
  })

  it.runIf(process.platform === 'win32')('prepares a UTF-8 svn.exe that commits, reads and reverts Czech paths without touching ASCII twins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-v3-svn-utf8-'))
    roots.push(root)
    const cacheDir = join(root, 'cache')
    const resolved = SvnExecutable.resolve(process.env, { cacheDir })
    expect(resolved.utf8).toBe(true)
    expect(existsSync(resolved.command)).toBe(true)
    expect(SvnWorktreeEvidence.takesArgument('prototypes/labIot/wiki/Články/Měřicí stanice LS-200.md')).toBe(true)

    const repository = join(root, 'repo')
    const wc = join(root, 'wc')
    execFileSync('svnadmin', ['create', repository])
    const url = pathToFileURL(repository).href
    const svn = new SvnInvoker()
    expect((await svn.run(root, ['checkout', url, wc])).code).toBe(0)

    const dir = resolve(wc, 'prototypes/labIot/wiki/Články')
    const md = resolve(dir, 'Měřicí stanice LS-200.md')
    const svg = resolve(dir, 'ls-200-schema.svg')
    const czech = resolve(wc, 'ř.txt')
    const asciiTwin = resolve(wc, 'r.txt')
    await mkdir(dir, { recursive: true })
    await writeFile(md, 'Měřicí stanice LS-200\n', 'utf8')
    await writeFile(svg, '<svg/>\n', 'utf8')
    await writeFile(czech, 'czech\n', 'utf8')
    await writeFile(asciiTwin, 'ascii twin\n', 'utf8')

    const messageFile = join(root, 'message.txt')
    await writeFile(messageFile, 'Add Czech wiki articles\n', 'utf8')

    const manager = new SvnCommitManager(svn)
    const committed = await manager.commit(wc, [
      { absolutePath: dir, nodeKind: 'directory', status: 'untracked' },
      { absolutePath: md, nodeKind: 'file', status: 'untracked' },
      { absolutePath: svg, nodeKind: 'file', status: 'untracked' },
      { absolutePath: czech, nodeKind: 'file', status: 'untracked' },
    ], messageFile)
    expect(committed).toMatchObject({ ok: true, value: { revision: '1' } })
    if (!committed.ok) throw new Error(committed.detail)
    expect(committed.value.committedPaths).toEqual(expect.arrayContaining([
      resolve(wc, 'prototypes'),
      resolve(wc, 'prototypes/labIot'),
      resolve(wc, 'prototypes/labIot/wiki'),
      dir,
      md,
      svg,
      czech,
    ]))
    expect(committed.value.committedPaths).not.toContain(asciiTwin)

    // Verify repository log and BASE cat hold the exact UTF-8 names and bytes, and r.txt stayed unversioned.
    const log = await svn.run(wc, ['log', '-v', '--xml', '-r', '1', url])
    expect(log.code).toBe(0)
    const logged = SvnWorktreeEvidence.loggedRows(log.stdout, '', '')
    expect(logged.map((row) => row.path)).toEqual(expect.arrayContaining([
      'prototypes/labIot/wiki/Články',
      'prototypes/labIot/wiki/Články/Měřicí stanice LS-200.md',
      'prototypes/labIot/wiki/Články/ls-200-schema.svg',
      'ř.txt',
    ]))
    expect(logged.map((row) => row.path)).not.toContain('r.txt')

    const cat = await svn.run(wc, ['cat', '--non-interactive', '-r', 'BASE', '--', `${md}@`])
    expect(cat.code).toBe(0)
    expect(cat.stdout).toBe('Měřicí stanice LS-200\n')

    await writeFile(md, 'edited\n', 'utf8')
    expect(await manager.revertFile(wc, md)).toEqual({ ok: true, value: undefined })
    expect(await readFile(md, 'utf8')).toBe('Měřicí stanice LS-200\n')

    const status = await svn.run(wc, ['status', '--xml', '--', '.'])
    expect(status.code).toBe(0)
    expect(SvnWorktreeEvidence.statusRows(status.stdout, wc)).toEqual([
      { kind: 'item', conflict: false, path: 'r.txt', unversioned: true },
    ])
    expect(dirname(resolved.command)).toBe(cacheDir)
  }, 30_000)
})
