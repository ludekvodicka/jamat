import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorktreeConfig } from '../../projectSetup/worktreeConfig'
import { CommandAgreement } from './commandAgreement'
import { CommandTrustStore } from './commandTrustStore'

describe('lib-orchestrator/sessionManager/scripts/commandAgreement', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix))
    created.push(directory)
    return directory
  }

  function project(config?: unknown): string {
    const root = temporaryDirectory('jamat-v3-agreement-project-')
    if (config !== undefined) write(root, config)
    return root
  }

  function write(root: string, config: unknown): void {
    const raw = typeof config === 'string' ? config : JSON.stringify(config)
    writeFileSync(join(root, '.worktree.json'), raw, 'utf8')
  }

  function harness(trustFile?: string): { agreement: CommandAgreement; trustFile: string } {
    const file = trustFile ?? join(temporaryDirectory('jamat-v3-agreement-state-'), 'setup-trust.json')
    return { agreement: new CommandAgreement({ trust: CommandTrustStore.load(file, () => undefined) }), trustFile: file }
  }

  async function hashOf(agreement: CommandAgreement, root: string): Promise<string> {
    const read = await agreement.declared(root)
    if (read.kind !== 'read' || read.value === null) throw new Error('nothing declared')
    return read.value.hash
  }

  async function gate(agreement: CommandAgreement, root: string, acknowledge: string | undefined) {
    return agreement.gate(root, await agreement.declared(root), acknowledge)
  }

  async function agreed(agreement: CommandAgreement, root: string): Promise<boolean> {
    return agreement.agreed(root, await agreement.declared(root))
  }

  const scripts = {
    before: [{ name: 'codegen', command: 'pnpm codegen' }],
    after: [{ name: 'tests', command: 'pnpm test', cwd: 'packages/app' }],
  }

  describe('hashOf', () => {
    /*
     * `sha256(JSON.stringify(["pnpm install"]))`, which is what the build before scripts existed
     * wrote into the trust file. Changing it withdraws every agreement a person gave there.
     */
    it('hashes a setup alone exactly as the build before scripts did', () => {
      expect(CommandAgreement.hashOf(['pnpm install'], { before: [], after: [] }))
        .toBe('4bf14ace60b83b2584114ecd0bb034351587e865784f16cc2978cc66e1acca34')
    })

    it('answers the same for the same commands and differently for a different order', () => {
      const none = { before: [], after: [] }
      expect(CommandAgreement.hashOf(['a', 'b'], none)).toBe(CommandAgreement.hashOf(['a', 'b'], none))
      expect(CommandAgreement.hashOf(['a', 'b'], none)).not.toBe(CommandAgreement.hashOf(['b', 'a'], none))
      expect(CommandAgreement.hashOf(['a'], none)).not.toBe(CommandAgreement.hashOf(['a', ''], none))
    })

    it('keeps an agreement written by the build before scripts existed', async () => {
      const root = project({ setup: ['pnpm install'] })
      const { trustFile } = harness()
      CommandTrustStore.load(trustFile, () => undefined)
        .acknowledge(root, '4bf14ace60b83b2584114ecd0bb034351587e865784f16cc2978cc66e1acca34')

      expect(await gate(harness(trustFile).agreement, root, undefined)).toBe(null)
    })
  })

  describe('declared', () => {
    it('reads the file once and keeps what setup says beside the commands it hashed', async () => {
      const root = project({ setup: ['pnpm install'], scripts })
      const load = vi.spyOn(WorktreeConfig, 'load')

      const read = await harness().agreement.declared(root)

      expect(load).toHaveBeenCalledTimes(1)
      expect(read).toMatchObject({
        kind: 'read',
        config: { ok: true, value: { setup: ['pnpm install'] } },
        value: { setup: ['pnpm install'], scripts: { before: [{ name: 'codegen' }] } },
      })
      load.mockRestore()
    })

    it('answers the read it was given, whatever the file says by now', async () => {
      const root = project({ setup: ['pnpm install'], scripts })
      const { agreement } = harness()
      const read = await agreement.declared(root)
      const hash = await hashOf(agreement, root)
      write(root, { setup: ['./evil.sh'], scripts })

      expect(agreement.gate(root, read, hash)).toBe(null)
      expect(agreement.agreed(root, read)).toBe(true)
      expect(await agreed(agreement, root)).toBe(false)
    })
  })

  describe('gate', () => {
    it('asks with every command labeled by its phase', async () => {
      const root = project({ setup: ['pnpm install'], scripts })
      const { agreement } = harness()

      expect(await gate(agreement, root, undefined)).toEqual({
        ok: false,
        code: 'setup-not-acknowledged',
        detail: `${join(root, '.worktree.json')} asks to run 3 commands in its worktrees, and this machine `
          + 'has not agreed to them',
        setup: {
          commands: ['pnpm install', 'before codegen: pnpm codegen', 'after tests (in packages/app): pnpm test'],
          hash: await hashOf(agreement, root),
        },
      })
    })

    it('remembers the answer and asks nothing more for the same commands', async () => {
      const root = project({ setup: ['pnpm install'], scripts })
      const { agreement, trustFile } = harness()
      const hash = await hashOf(agreement, root)

      expect(await gate(agreement, root, 'hash-of-something-else')).toMatchObject({ code: 'setup-not-acknowledged' })
      expect(await gate(agreement, root, hash)).toBe(null)
      expect(await gate(harness(trustFile).agreement, root, undefined)).toBe(null)
      expect(await agreed(agreement, root)).toBe(true)
    })

    /* A project that reformats its file has not changed what it runs, and being asked again would
       teach people to click through. */
    it('keeps an agreement across a reformat of the file', async () => {
      const root = project({ setup: ['a', 'b'], scripts })
      const { agreement } = harness()
      expect(await gate(agreement, root, await hashOf(agreement, root))).toBe(null)

      write(root, JSON.stringify({ dev: 'pnpm dev', scripts, setup: ['a', 'b'] }, null, 4))

      expect(await agreed(agreement, root)).toBe(true)
    })

    const ordered ={ before: [{ name: 'a', command: 'one' }, { name: 'b', command: 'two' }], after: [] }
    it.each([
      ['adding a script', scripts, { ...scripts, before: [...scripts.before, { name: 'lint', command: 'pnpm lint' }] }],
      ['removing a script', scripts, { ...scripts, before: [] }],
      ['reordering the scripts', ordered, { ...ordered, before: [...ordered.before].reverse() }],
      ['editing a command', scripts, { ...scripts, before: [{ name: 'codegen', command: 'pnpm codegen --force' }] }],
      ['moving a script to another directory', scripts, { ...scripts, after: [{ name: 'tests', command: 'pnpm test' }] }],
    ])('asks again after %s', async (_label, initial, changed) => {
      const root = project({ setup: ['pnpm install'], scripts: initial })
      const { agreement } = harness()
      expect(await gate(agreement, root, await hashOf(agreement, root))).toBe(null)

      write(root, { setup: ['pnpm install'], scripts: changed })

      expect(await agreed(agreement, root)).toBe(false)
      expect(await gate(agreement, root, undefined)).toMatchObject({ code: 'setup-not-acknowledged' })
    })

    it('asks about scripts declared without a setup', async () => {
      const root = project({ scripts: { before: [{ name: 'codegen', command: 'pnpm codegen' }] } })

      expect(await gate(harness().agreement, root, undefined)).toMatchObject({
        code: 'setup-not-acknowledged',
        setup: { commands: ['before codegen: pnpm codegen'] },
      })
    })

    it('has nothing to ask about when the project declares nothing of its own', async () => {
      const { agreement } = harness()

      for (const root of [
        project(),
        project({ dev: 'pnpm dev' }),
        project({ setup: [] }),
        project({ setup: [], scripts: { before: [], after: [] } }),
      ]) {
        expect(await gate(agreement, root, undefined)).toBe(null)
        expect(await agreed(agreement, root)).toBe(true)
      }
    })

    // Nothing in it can run, so a create carries on and skips; whoever runs commands asks `agreed`.
    it('lets a file nobody can read through the gate, and never agrees to it', async () => {
      const root = project('{ "setup": [')
      const { agreement } = harness()
      const read = await agreement.declared(root)

      expect(read).toEqual({ kind: 'unreadable', problem: expect.stringContaining('is not valid JSON') })
      expect(agreement.gate(root, read, undefined)).toBe(null)
      expect(agreement.agreed(root, read)).toBe(false)
    })

    it('counts the scripts beside a damaged setup', async () => {
      const root = project({ setup: 'pnpm install', scripts: { after: [{ name: 'tests', command: 'pnpm test' }] } })

      expect(await gate(harness().agreement, root, undefined)).toMatchObject({
        code: 'setup-not-acknowledged',
        setup: { commands: ['after tests: pnpm test'] },
      })
    })

    it('refuses a damaged scripts key, and never agrees to it', async () => {
      const root = project({ setup: ['pnpm install'], scripts: { befor: [] } })
      const { agreement } = harness()

      expect(await gate(agreement, root, undefined)).toEqual({
        ok: false,
        code: 'invalid-spec',
        detail: expect.stringContaining('"scripts" has an unknown key "befor"'),
      })
      expect(await agreed(agreement, root)).toBe(false)
    })
  })
})
