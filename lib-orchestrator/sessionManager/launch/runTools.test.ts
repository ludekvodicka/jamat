import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunTools } from './runTools'

describe('lib-orchestrator/sessionManager/launch/runTools', () => {
  const applicationRoot = resolve(import.meta.dirname, '../../..')
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function directory(files: readonly string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-run-tools-'))
    roots.push(root)
    for (const file of files) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), '')
    }
    return root
  }

  describe('svn', () => {
    it('answers the svn.exe image on PATH on Windows, never cmd.exe', () => {
      const bin = directory(['svn.exe'])
      const tools = new RunTools({
        resourcesRoot: null, applicationRoot, platform: 'win32',
        environment: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      })
      expect(tools.resolve('svn')).toEqual({ ok: true, command: join(bin, 'svn.exe'), prefixArgs: [], env: { LC_ALL: 'C', LANG: 'C' } })
    })

    it('says so when PATH holds no svn.exe, even with a shim of that name', () => {
      const bin = directory(['svn.cmd'])
      const tools = new RunTools({
        resourcesRoot: null, applicationRoot, platform: 'win32', environment: { PATH: bin, PATHEXT: '.EXE;.CMD' },
      })
      expect(tools.resolve('svn')).toEqual({
        ok: false, detail: 'svn.exe was not found on PATH; install the Subversion command-line client',
      })
    })

    it('refuses missing SVN before a PATH shim can recursively invoke itself', () => {
      const tools = new RunTools({ resourcesRoot: null, applicationRoot, platform: 'linux', environment: {} })
      expect(tools.resolve('svn')).toEqual({ ok: false, detail: 'svn was not found on PATH; install the Subversion command-line client' })
    })
  })

  describe('jamat-cli', () => {
    it('answers the packaged Node runtime and CLI bundle in a packaged client', () => {
      const resources = directory(['launcher/node.exe', 'cli/jamat-v3.cjs'])
      const tools = new RunTools({ resourcesRoot: resources, applicationRoot, platform: 'win32', environment: {} })
      expect(tools.resolve('jamat-cli')).toEqual({
        ok: true,
        command: join(resources, 'launcher', 'node.exe'),
        prefixArgs: [join(resources, 'cli', 'jamat-v3.cjs')],
        env: {},
      })
      const posix = directory(['launcher/bin/node', 'cli/jamat-v3.cjs'])
      expect(new RunTools({ resourcesRoot: posix, applicationRoot, platform: 'linux', environment: {} })
        .resolve('jamat-cli')).toMatchObject({ ok: true, command: join(posix, 'launcher', 'bin/node') })
    })

    // A packaged client with a broken bundle must not quietly run whatever checkout it was built from.
    it('says which packaged file is missing and never falls back to the development CLI', () => {
      const noBundle = directory(['launcher/node.exe'])
      expect(new RunTools({ resourcesRoot: noBundle, applicationRoot, platform: 'win32', environment: {} })
        .resolve('jamat-cli')).toEqual({
        ok: false, detail: `The packaged Jamat CLI is missing: ${join(noBundle, 'cli', 'jamat-v3.cjs')}`,
      })
      const noNode = directory(['cli/jamat-v3.cjs'])
      expect(new RunTools({ resourcesRoot: noNode, applicationRoot, platform: 'win32', environment: {} })
        .resolve('jamat-cli')).toEqual({
        ok: false, detail: `The packaged Node runtime is missing: ${join(noNode, 'launcher', 'node.exe')}`,
      })
    })

    it('runs the CLI source through tsx with its own tsconfig in development', () => {
      const resolved = new RunTools({ resourcesRoot: null, applicationRoot, environment: process.env }).resolve('jamat-cli')
      if (!resolved.ok) throw new Error(resolved.detail)
      expect(resolved.command).toBe(process.execPath)
      expect(resolved.prefixArgs).toHaveLength(3)
      expect(resolved.prefixArgs[0]).toBe('--import')
      expect(resolved.prefixArgs[1]).toMatch(/^file:\/\/.*\/tsx\//)
      expect(resolved.prefixArgs[2]).toBe(join(applicationRoot, 'app-client-cli', 'start.ts'))
      expect(resolved.env).toEqual({ TSX_TSCONFIG_PATH: join(applicationRoot, 'app-client-cli', 'tsconfig.json') })
    })

    it('says so when the development CLI is not there', () => {
      const empty = directory()
      expect(new RunTools({ resourcesRoot: null, applicationRoot: empty, environment: {} }).resolve('jamat-cli')).toEqual({
        ok: false, detail: `The development Jamat CLI is missing: ${join(empty, 'app-client-cli', 'start.ts')}`,
      })
    })
  })

  // The merger's brief and its allow list name this line, so it must be THIS client's CLI: the
  // person's ~/.claude skill can belong to another installation (UA1-J14-9).
  describe('agentCli', () => {
    it('names the appjamat-v3 wrapper this client ships, with forward slashes and quotes', () => {
      const root = directory(['skills/claude/appjamat-v3/scripts/jamat-v3.mjs'])
      const tools = new RunTools({ resourcesRoot: null, applicationRoot: root, platform: 'win32', environment: {} })
      expect(tools.agentCli()).toEqual({
        ok: true, command: `node "${join(root, 'skills', 'claude', 'appjamat-v3', 'scripts', 'jamat-v3.mjs').replaceAll('\\', '/')}"`,
      })
    })

    it('says which wrapper is missing', () => {
      const root = directory()
      const tools = new RunTools({ resourcesRoot: null, applicationRoot: root, platform: 'win32', environment: {} })
      expect(tools.agentCli()).toEqual({
        ok: false, detail: `The Jamat CLI wrapper is missing: ${join(root, 'skills', 'claude', 'appjamat-v3', 'scripts', 'jamat-v3.mjs')}`,
      })
    })
  })
})
