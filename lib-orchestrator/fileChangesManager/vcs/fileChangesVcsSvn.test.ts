import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileChangesVcsSvn } from './fileChangesVcsSvn'
import type {
  CommandOutcome,
  CommandRunner,
} from '../../shared/commandInvoker.types'

describe('lib-orchestrator/fileChangesManager/vcs/fileChangesVcsSvn', () => {
  it('names its own default and history baselines', () => {
    const adapter = new FileChangesVcsSvn()

    expect(adapter.defaultBaselineRef).to.deep.equal({ kind: 'svn-base', revision: 'BASE' })
    expect(adapter.historyBaselineRef('42'))
      .to.deep.equal({ kind: 'svn-revision', revision: '42' })
  })

  const created: string[] = []

  class Runner implements CommandRunner {
    constructor(private readonly answer: (args: string[], cwd: string) => CommandOutcome) {}

    async run(cwd: string, args: string[]): Promise<CommandOutcome> {
      return this.answer(args, cwd)
    }
  }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function workingCopy(): { root: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-svn-vcs-'))
    const cwd = join(root, 'nested')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'changed.ts'), 'current\n', 'utf8')
    created.push(root)
    return { root, cwd }
  }

  function ok(stdout = ''): CommandOutcome {
    return { code: 0, stdout, stderr: '', failure: null }
  }

  function detectionAnswer(root: string, args: string[]): CommandOutcome | null {
    if (args[0] !== 'info') return null
    const item = args[args.indexOf('--show-item') + 1]
    if (item === 'wc-root') return ok(root)
    else if (item === 'url') return ok('https://svn.example/repo/trunk/nested')
    else if (item === 'relative-url') return ok('^/trunk/nested')
    else throw new Error(item)
  }

  it('parses file and directory working states and excludes normal rows', async () => {
    const { root, cwd } = workingCopy()
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(`<?xml version="1.0"?>
      <status><target path=".">
        <entry path="changed.ts"><wc-status item="modified" props="none" revision="2"/></entry>
        <entry path="new"><wc-status item="unversioned" props="none"/></entry>
        <entry path="normal.ts"><wc-status item="normal" props="none" revision="2"/></entry>
      </target></status>`))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.status(detected)).toEqual({
      ok: true,
      value: { externalRoots: [], entries: [
        expect.objectContaining({ repositoryPath: 'nested/changed.ts', status: 'modified' }),
        expect.objectContaining({ repositoryPath: 'nested/new', status: 'untracked' }),
      ] },
    })
  })

  it('names where a moved file came from, as svn 1.14 writes it relative to the cwd, and keeps it an add', async () => {
    const { root, cwd } = workingCopy()
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(`<?xml version="1.0"?>
      <status><target path=".">
        <entry path="src\\a.txt"><wc-status moved-to="src\\a2.txt" item="deleted" revision="1" props="none"/></entry>
        <entry path="src\\a2.txt"><wc-status props="none" copied="true" moved-from="src\\a.txt" item="added"/></entry>
        <entry path="src\\c.txt"><wc-status item="added" props="none" copied="true"/></entry>
      </target></status>`))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    const status = await vcs.status(detected)
    expect(status.ok && status.value.entries.map((entry) => [entry.repositoryPath, entry.status, entry.previousAbsolutePath, entry.previousRepositoryPath]))
      .toEqual([
        ['nested/src/a.txt', 'deleted', null, null],
        ['nested/src/a2.txt', 'added', resolve(cwd, 'src', 'a.txt'), 'nested/src/a.txt'],
        ['nested/src/c.txt', 'added', null, null],
      ])
  })

  it('excludes only SVN-reported unversioned conflict files and retains versioned cleanup and unrelated names', async () => {
    const { root, cwd } = workingCopy()
    const vcs = new FileChangesVcsSvn(new Runner((args) => {
      if (args[0] === 'info' && args[1] === '--xml') return ok(`<info><entry path="changed.ts" kind="file">
        <conflict type="text"><prev-base-file>${join(cwd, 'changed.ts.r1')}</prev-base-file>
        <prev-wc-file>${join(cwd, 'changed.ts.mine')}</prev-wc-file>
        <cur-base-file>${join(cwd, 'changed.ts.r2')}</cur-base-file></conflict></entry></info>`)
      return detectionAnswer(root, args) ?? ok(`<status><target path=".">
        <entry path="changed.ts"><wc-status item="conflicted" props="none"/></entry>
        <entry path="changed.ts.r1"><wc-status item="unversioned" props="none"/></entry>
        <entry path="changed.ts.mine"><wc-status item="unversioned" props="none"/></entry>
        <entry path="changed.ts.r2"><wc-status item="deleted" props="none"/></entry>
        <entry path="unrelated.mine"><wc-status item="unversioned" props="none"/></entry>
      </target></status>`)
    }))
    expect(await vcs.status((await vcs.detect(cwd))!)).toMatchObject({ ok: true, value: { entries: [
      { absolutePath: join(cwd, 'changed.ts'), status: 'conflicted' },
      { absolutePath: join(cwd, 'changed.ts.r2'), status: 'deleted' },
      { absolutePath: join(cwd, 'unrelated.mine'), status: 'untracked' },
    ] } })
  })

  it('refuses the changes list when SVN cannot identify conflict files', async () => {
    const { root, cwd } = workingCopy()
    const vcs = new FileChangesVcsSvn(new Runner((args) => {
      if (args[0] === 'info' && args[1] === '--xml') return { code: 1, stdout: '', stderr: 'Working copy is locked', failure: null }
      return detectionAnswer(root, args) ?? ok('<status><target path="."><entry path="changed.ts"><wc-status item="conflicted" props="none"/></entry></target></status>')
    }))
    expect(await vcs.status((await vcs.detect(cwd))!)).toMatchObject({ ok: false, detail: expect.stringContaining('Could not identify SVN conflict files') })
  })

  it('reads the BASE and working values of changed properties, of files, directories and the scope itself', async () => {
    const { root, cwd } = workingCopy()
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'added.txt'), 'new\n', 'utf8')
    const at = (name: string): string => name === '.' ? cwd : join(cwd, name)
    const target = (name: string, properties: Record<string, string>): string => `<target path="${at(name)}">${Object.entries(properties)
      .map(([key, value]) => `<property name="${key}">${value}</property>`).join('')}</target>`
    const commands: string[][] = []
    const vcs = new FileChangesVcsSvn(new Runner((args) => {
      if (args[0] === 'proplist') {
        commands.push(args)
        return ok(args.includes('BASE')
          ? `<properties>${target('changed.ts', { 'jamat:test': 'base', 'svn:eol-style': 'native', gone: 'old' })}
            ${target('src', { 'svn:ignore': 'x&#13;\ny&#13;\n' })}</properties>`
          : `<properties>${target('changed.ts', { 'jamat:test': 'w1-prop-only', 'svn:eol-style': 'native' })}
            ${target('src', { 'svn:ignore': 'x&#13;\nz&#13;\n', 'svn:externals': '^/lib lib' })}
            ${target('.', { root: 'set' })}${target('added.txt', { 'svn:mime-type': 'text/plain' })}</properties>`)
      }
      return detectionAnswer(root, args) ?? ok(`<status><target path=".">
        <entry path="."><wc-status item="normal" props="modified" revision="2"/></entry>
        <entry path="changed.ts"><wc-status item="normal" props="modified" revision="2"/></entry>
        <entry path="src"><wc-status item="normal" props="modified" revision="2"/></entry>
        <entry path="added.txt"><wc-status item="added" props="modified" revision="-1"/></entry>
        <entry path="text.ts"><wc-status item="modified" props="normal" revision="2"/></entry>
      </target></status>`)
    }))

    const result = await vcs.status((await vcs.detect(cwd))!)

    expect(result).toEqual({ ok: true, value: { externalRoots: [], entries: [
      expect.objectContaining({ absolutePath: cwd, properties: { changes: [{ name: 'root', before: null, after: 'set' }], detail: null } }),
      expect.objectContaining({ absolutePath: at('changed.ts'), properties: { changes: [
        { name: 'gone', before: 'old', after: null },
        { name: 'jamat:test', before: 'base', after: 'w1-prop-only' },
      ], detail: null } }),
      expect.objectContaining({ absolutePath: at('src'), nodeKind: 'directory', properties: { changes: [
        { name: 'svn:externals', before: null, after: '^/lib lib' },
        { name: 'svn:ignore', before: 'x\r\ny\r\n', after: 'x\r\nz\r\n' },
      ], detail: null } }),
      expect.objectContaining({ absolutePath: at('added.txt'), status: 'added',
        properties: { changes: [{ name: 'svn:mime-type', before: null, after: 'text/plain' }], detail: null } }),
      expect.objectContaining({ absolutePath: at('text.ts'), status: 'modified' }),
    ] } })
    expect(result.ok && result.value.entries[4]).not.toHaveProperty('properties')
    // BASE answers nothing for an added node, so both reads take every node.
    expect(commands).toEqual([
      ['proplist', '--xml', '--verbose', '--non-interactive', '--', `${cwd}@`, `${at('changed.ts')}@`, `${at('src')}@`, `${at('added.txt')}@`],
      ['proplist', '--xml', '--verbose', '--non-interactive', '-r', 'BASE', '--', `${cwd}@`, `${at('changed.ts')}@`, `${at('src')}@`, `${at('added.txt')}@`],
    ])
  })

  it('keeps the changes list and says why when property values cannot be read, and cuts a long value', async () => {
    const { root, cwd } = workingCopy()
    const long = 'v'.repeat(5_000)
    let failing = true
    const vcs = new FileChangesVcsSvn(new Runner((args) => {
      if (args[0] === 'proplist')
        return failing ? { code: 1, stdout: '', stderr: 'svn: E155037: locked', failure: null }
          : ok(args.includes('BASE') ? '<properties></properties>'
            : `<properties><target path="${join(cwd, 'changed.ts')}"><property name="big">${long}</property></target></properties>`)
      return detectionAnswer(root, args) ?? ok(`<status><target path=".">
        <entry path="changed.ts"><wc-status item="normal" props="modified" revision="2"/></entry></target></status>`)
    }))
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.status(detected)).toMatchObject({ ok: true, value: { entries: [{ status: 'modified',
      properties: { changes: [], detail: expect.stringContaining('Property values could not be read: svn: E155037: locked') } }] } })
    failing = false
    expect(await vcs.status(detected)).toMatchObject({ ok: true, value: { entries: [{
      properties: { changes: [{ name: 'big', before: null, after: `${'v'.repeat(4_000)}…` }], detail: 'Values longer than 4000 characters are cut.' } }] } })
  })

  it('reads a literal file at depth empty without scanning the scope', async () => {
    const { root, cwd } = workingCopy()
    const path = join(cwd, 'name@file.ts')
    const commands: string[][] = []
    const vcs = new FileChangesVcsSvn(new Runner((args) => {
      commands.push(args)
      return detectionAnswer(root, args) ?? ok(`<status><target path="${path}"><entry path="${path}">
        <wc-status item="modified" props="none" revision="2"/></entry></target></status>`)
    }))
    const result = await vcs.status((await vcs.detect(cwd))!, path)
    expect(result).toMatchObject({ ok: true, value: { entries: [{ absolutePath: path, repositoryPath: 'nested/name@file.ts' }] } })
    expect(commands.find((args) => args[0] === 'status')).toEqual([
      'status', '--xml', '--non-interactive', '--depth', 'empty', '--', `${path}@`,
    ])
  })

  it('filters verbose log paths to the cwd and preserves copy metadata', async () => {
    const { root, cwd } = workingCopy()
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(`<?xml version="1.0"?>
      <log><logentry revision="42"><author>Ada</author><date>2026-08-14T08:00:00.000Z</date>
        <paths>
          <path action="M" kind="file">/trunk/nested/changed.ts</path>
          <path action="A" kind="file" copyfrom-path="/trunk/nested/old.ts">/trunk/nested/new.ts</path>
          <path action="M" kind="file">/trunk/sibling.ts</path>
        </paths><msg>message</msg></logentry></log>`))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.history(detected, 10)).toEqual({
      ok: true,
      value: [expect.objectContaining({
        revision: '42',
        label: 'r42',
        entries: [
          expect.objectContaining({ repositoryPath: 'nested/changed.ts', status: 'modified' }),
          expect.objectContaining({
            repositoryPath: 'nested/new.ts',
            previousRepositoryPath: 'nested/old.ts',
            status: 'copied',
          }),
        ],
      })],
    })
  })

  it('keeps nested external roots and their changed files', async () => {
    const { root, cwd } = workingCopy()
    mkdirSync(join(cwd, 'shared/.svn'), { recursive: true })
    const vcs = new FileChangesVcsSvn(new Runner((args) => detectionAnswer(root, args) ?? ok(`
      <status><target path=".">
        <entry path="shared"><wc-status item="external" props="none"/></entry>
      </target><target path="shared">
        <entry path="shared/a.ts"><wc-status item="modified" props="none"/></entry>
        <entry path="shared/b.ts"><wc-status item="modified" props="none"/></entry>
      </target></status>`)))

    const result = await vcs.status((await vcs.detect(cwd))!)

    expect(result).toEqual({ ok: true, value: {
      externalRoots: [join(cwd, 'shared')],
      entries: [
        expect.objectContaining({ absolutePath: join(cwd, 'shared/a.ts'), status: 'modified' }),
        expect.objectContaining({ absolutePath: join(cwd, 'shared/b.ts'), status: 'modified' }),
      ],
    } })
  })

  it('groups changed files by actual checkouts below an X container, including nested mounts', async () => {
    const { root, cwd } = workingCopy()
    const first = join(cwd, 'shared/library'), nested = join(first, 'vendor/nested'), second = join(cwd, 'shared/other')
    for (const path of [first, nested, second]) mkdirSync(join(path, '.svn'), { recursive: true })
    const vcs = new FileChangesVcsSvn(new Runner((args) => detectionAnswer(root, args) ?? ok(`<status><target path=".">
      <entry path="shared"><wc-status item="external" props="none"/></entry>
      <entry path="shared/library/a.ts"><wc-status item="modified" props="none"/></entry>
      <entry path="shared/library/missing.ts"><wc-status item="deleted" props="none"/></entry>
      <entry path="shared/library/vendor/nested/b.ts"><wc-status item="modified" props="none"/></entry>
      <entry path="shared/other/new.ts"><wc-status item="unversioned" props="none"/></entry>
    </target></status>`)))
    expect(await vcs.status((await vcs.detect(cwd))!)).toMatchObject({ ok: true, value: {
      externalRoots: [first, nested, second], entries: [
        { absolutePath: join(first, 'a.ts') }, { absolutePath: join(first, 'missing.ts') },
        { absolutePath: join(nested, 'b.ts') }, { absolutePath: join(second, 'new.ts') },
      ],
    } })
  })

  it('refuses changed files below an X container without checkout metadata', async () => {
    const { root, cwd } = workingCopy()
    const vcs = new FileChangesVcsSvn(new Runner((args) => detectionAnswer(root, args) ?? ok(`<status><target path=".">
      <entry path="shared"><wc-status item="external" props="none"/></entry>
      <entry path="shared/missing/a.ts"><wc-status item="modified" props="none"/></entry>
    </target></status>`)))
    expect(await vcs.status((await vcs.detect(cwd))!)).toMatchObject({ ok: false,
      detail: expect.stringContaining('Could not identify the external working copy') })
  })

  function infoAnswer(entries: readonly { path: string; url: string; root?: string; wcRoot: string }[]): CommandOutcome {
    return ok(`<info>${entries.map((entry) => `<entry path="${entry.path}" kind="dir">
      <url>${entry.url}</url><relative-url>^${entry.url.slice((entry.root ?? 'https://svn.example/repo').length)}</relative-url>
      <repository><root>${entry.root ?? 'https://svn.example/repo'}</root></repository>
      <wc-info><wcroot-abspath>${entry.wcRoot.replace(/\\/g, '/')}</wcroot-abspath></wc-info></entry>`).join('')}</info>`)
  }

  it('reads a checkout at its own path that SVN reports as an external it never walks', async () => {
    const { root, cwd } = workingCopy()
    const project = join(cwd, 'project')
    const external = join(cwd, 'shared', 'lib')
    for (const path of [project, external]) mkdirSync(join(path, '.svn'), { recursive: true })
    const vcs = new FileChangesVcsSvn(new Runner((args, runCwd) => {
      if (args[0] === 'info' && args[1] === '--xml') return infoAnswer([
        { path: '.', url: 'https://svn.example/repo/trunk/nested', wcRoot: root },
        { path: project, url: 'https://svn.example/repo/trunk/nested/project', wcRoot: project },
        { path: external, url: 'https://svn.example/repo/libraries/lib', wcRoot: external },
      ])
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      if (runCwd === project) return ok(`<status><target path=".">
        <entry path="a.ts"><wc-status item="modified" props="none"/></entry>
        <entry path="new.ts"><wc-status item="unversioned" props="none"/></entry>
      </target></status>`)
      return ok(`<status><target path=".">
        <entry path="project"><wc-status item="external" props="none"/></entry>
        <entry path="shared/lib"><wc-status item="external" props="none"/></entry>
      </target></status>`)
    }))

    const result = await vcs.status((await vcs.detect(cwd))!)

    expect(result).toEqual({ ok: true, value: {
      externalRoots: [external],
      entries: [
        expect.objectContaining({ absolutePath: join(project, 'a.ts'), repositoryPath: 'nested/project/a.ts', status: 'modified' }),
        expect.objectContaining({ absolutePath: join(project, 'new.ts'), repositoryPath: 'nested/project/new.ts', status: 'untracked' }),
      ],
    } })
  })

  it('joins an unversioned checkout of the same repository and groups one of another repository', async () => {
    const { root, cwd } = workingCopy()
    const same = join(cwd, 'same')
    const foreign = join(cwd, 'foreign')
    for (const path of [same, foreign]) mkdirSync(join(path, '.svn'), { recursive: true })
    const vcs = new FileChangesVcsSvn(new Runner((args, runCwd) => {
      if (args[0] === 'info' && args[1] === '--xml') return infoAnswer([
        { path: '.', url: 'https://svn.example/repo/trunk/nested', wcRoot: root },
        { path: same, url: 'https://svn.example/repo/branches/same', wcRoot: same },
        { path: foreign, url: 'https://svn.example/other/trunk', root: 'https://svn.example/other', wcRoot: foreign },
      ])
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      if (runCwd === same || runCwd === foreign) return ok(`<status><target path=".">
        <entry path="x.ts"><wc-status item="modified" props="none"/></entry>
      </target></status>`)
      return ok(`<status><target path=".">
        <entry path="same"><wc-status item="unversioned" props="none"/></entry>
        <entry path="foreign"><wc-status item="unversioned" props="none"/></entry>
      </target></status>`)
    }))

    const result = await vcs.status((await vcs.detect(cwd))!)

    expect(result).toEqual({ ok: true, value: {
      externalRoots: [foreign],
      entries: [
        expect.objectContaining({ absolutePath: join(same, 'x.ts'), repositoryPath: 'nested/same/x.ts', status: 'modified' }),
        expect.objectContaining({ absolutePath: join(foreign, 'x.ts'), repositoryPath: 'nested/foreign/x.ts', status: 'modified' }),
      ],
    } })
  })

  it('reads a baseline as the bytes svn printed, so a binary file keeps them', async () => {
    const { root, cwd } = workingCopy()
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0xfe, 0x80])
    const asked: unknown[] = []
    const vcs = new FileChangesVcsSvn({ run: async (_cwd: string, args: string[], options?: unknown) => {
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      asked.push(options)
      return { ...ok(bytes.toString('utf8')), stdoutBytes: bytes }
    } })
    const detected = (await vcs.detect(cwd))!

    const baseline = await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-base', revision: 'BASE' })
    expect(baseline.kind === 'content' && Buffer.isBuffer(baseline.content) && baseline.content.equals(bytes)).toBe(true)
    expect(asked).toEqual([expect.objectContaining({ stdoutBytes: true })])
  })

  it('reads the BASE of a replaced file from the revision svn status names, since svn cat has no pristine for it', async () => {
    const { root, cwd } = workingCopy()
    const target = join(root, 'nested', 'changed.ts')
    const calls: string[][] = []
    const vcs = new FileChangesVcsSvn({ run: async (_cwd: string, args: string[]) => {
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      calls.push(args)
      if (args[0] === 'cat' && args.includes('BASE'))
        return { code: 1, stdout: '', stderr: `svn: E200009: '${target}' has no pristine version until it is committed`, failure: null }
      if (args[0] === 'status')
        return ok(`<?xml version="1.0"?><status><target path="${target}"><entry path="${target}"><wc-status item="replaced" revision="3" props="none"/></entry></target></status>`)
      if (args[0] === 'cat') return { ...ok('incoming\n'), stdoutBytes: Buffer.from('incoming\n') }
      throw new Error(JSON.stringify(args))
    } })
    const detected = (await vcs.detect(cwd))!

    const baseline = await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-base', revision: 'BASE' })
    expect(baseline.kind === 'content' && baseline.content.toString()).toBe('incoming\n')
    expect(calls.slice(1)).toEqual([
      ['status', '--xml', '--depth', 'empty', '--non-interactive', '--', `${target}@`],
      ['cat', '--non-interactive', '-r', '3', '--', `${target}@3`],
    ])
  })

  it('uses the local BASE target and repository URL for a selected revision', async () => {
    const { root, cwd } = workingCopy()
    const targets: string[] = []
    const runner = new Runner((args) => {
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      if (args[0] === 'cat') {
        targets.push(args.at(-1)!)
        return ok('before\n')
      }
      throw new Error(JSON.stringify(args))
    })
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-base', revision: 'BASE' })
    await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-revision', revision: '42' })
    expect(targets).toEqual([
      `${join(root, 'nested', 'changed.ts')}@`,
      'https://svn.example/repo/trunk/nested/changed.ts@',
    ])
  })
})
