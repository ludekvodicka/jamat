import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProjectSetupManager } from '../../projectSetup/projectSetupManager'
import { SetupFamilies } from '../../projectSetup/setupFamilies'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { CommandAgreement } from '../scripts/commandAgreement'
import { CommandTrustStore } from '../scripts/commandTrustStore'
import { SetupFlow } from './setupFlow'

describe('lib-orchestrator/sessionManager/lifecycle/setupFlow', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function unexpected(name: string): never {
    throw new Error(`${name} is not part of planning the before chain`)
  }

  /** Keys are paths relative to the returned root; a file whose content does not matter is empty. */
  function directory(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-setup-flow-'))
    created.push(root)
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return root
  }

  async function flowOf(root: string): Promise<SetupFlow> {
    const records = await SessionRecordsStore.load(join(root, 'session-records.json'), {
      snapshotsDirectory: join(root, 'snapshots'),
      report: () => undefined,
    })
    return new SetupFlow({
      records,
      setup: new ProjectSetupManager({ platformSettingsOf: () => SetupFamilies.defaultPlatformSettings() }),
      agreement: new CommandAgreement({ trust: CommandTrustStore.load(join(root, 'setup-trust.json'), () => undefined) }),
      scripts: { succeededKeys: () => unexpected('succeededKeys') },
      runs: { launch: () => unexpected('launch') },
      launch: {
        replayLaunch: () => unexpected('replayLaunch'),
        unrecordedWorktree: () => unexpected('unrecordedWorktree'),
        startRefusal: () => unexpected('startRefusal'),
      },
      worktrees: { purgeReserved: () => unexpected('purgeReserved') },
      report: () => undefined,
      newId: () => unexpected('newId'),
      now: () => 5_000,
    })
  }

  /*
   * An SVN worktree of a product group checks out the whole group, and `setupProjectOf` names the
   * group root. Its members are what installs, with no agreement asked: the steps are this machine's.
   */
  it('plans one setup step that installs every member of a product group in the worktree', async () => {
    const state = directory({})
    const group = directory({
      '.appgroup': '',
      'SrvBackend/package.json': '{}',
      'SrvBackend/pnpm-lock.yaml': '',
      'WebAdmin/package.json': '{}',
      'WebAdmin/pnpm-lock.yaml': '',
      'data/readme.md': '# no manifest\n',
    })
    const worktreePath = join(group, '.worktrees', '045-panel')

    const plan = await (await flowOf(state)).beforePlanFor(group, group, worktreePath)

    expect(plan).toMatchObject({
      kind: 'run',
      skipped: null,
      steps: [{
        scriptId: 'setup',
        commands: [
          { command: 'pnpm install', cwd: join(worktreePath, 'SrvBackend') },
          { command: 'pnpm install', cwd: join(worktreePath, 'WebAdmin') },
        ],
      }],
    })
  })

  it('skips the setup of a group none of whose members it recognises, saying why', async () => {
    const state = directory({})
    const group = directory({ '.appgroup': '', 'data/readme.md': '# no manifest\n' })

    const plan = await (await flowOf(state)).beforePlanFor(group, group, join(group, '.worktrees', '046-x'))

    expect(plan).toMatchObject({ kind: 'skip', reason: expect.stringContaining('no known project family detected') })
  })
})
