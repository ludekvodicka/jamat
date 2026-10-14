/**
 * Builds the testbed for the SVN Finish conflict work: a scratch svnadmin repository with one main
 * copy at r1, and the two sides of eight named conflict scenarios. `--work` writes the session's side
 * into a worktree and commits nothing; `--land` commits the incoming side from a scratch checkout, so
 * the next Finish of that worktree meets it. Every manual check of the conflict units runs on this
 * data; `scripts/smoke/svn-worktree.ts` builds it once per scenario.
 *
 *   pnpm dev:conflict-testbed <root>                                 # builds <root>/repo and <root>/main
 *   pnpm dev:conflict-testbed <root> --work <worktree> <scenario>    # the session's side
 *   pnpm dev:conflict-testbed <root> --land <scenario>               # the incoming side, as a commit
 *
 * Plain svn and svnadmin only: the testbed must stay a fact about svn, independent of the code it tests.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type ConflictScenarioName = 'incident' | 'diverged' | 'text' | 'eol' | 'binary' | 'props' | 'delete' | 'kind'

export interface ConflictScenario {
  /** What each side does, in the words of the docs page. */
  session: string
  incoming: string
  /** The paths `svn status` names in the worktree after `--work`, '/'-separated, `.` for the root. */
  workPaths: string[]
  /** The paths the `--land` commit changes, '/'-separated, relative to the repository root. */
  landPaths: string[]
  work(worktree: string): void
  land(checkout: string): void
}

export class ConflictTestbed {
  static readonly scenarioNamesConst: readonly ConflictScenarioName[]
    = ['incident', 'diverged', 'text', 'eol', 'binary', 'props', 'delete', 'kind']
  /** Its presence lets a rebuild replace a testbed and nothing else. */
  private static readonly markerConst = '.conflict-testbed'
  /** A 1x1 PNG, red at r1 and blue in the `binary` scenario. */
  private static readonly redPngConst = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  private static readonly bluePngConst = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'

  static readonly scenariosConst: Readonly<Record<ConflictScenarioName, ConflictScenario>> = {
    incident: {
      session: 'adds the unversioned `.aidocs/engines/t1/` with 2 files; edits line 3 of `src/catalog.ts` and `src/wallets.ts`',
      incoming: 'adds `.aidocs/engines/t2/` with 3 files; edits line 3 of both source files differently',
      workPaths: ['.aidocs/engines', 'src/catalog.ts', 'src/wallets.ts'],
      landPaths: ['.aidocs/engines', '.aidocs/engines/t2', '.aidocs/engines/t2/brief.md', '.aidocs/engines/t2/report.md',
        '.aidocs/engines/t2/trail.md', 'src/catalog.ts', 'src/wallets.ts'],
      work: (worktree) => {
        ConflictTestbed.write(worktree, '.aidocs/engines/t1/brief.md', '# Brief t1\n\nWritten by the session.\n')
        ConflictTestbed.write(worktree, '.aidocs/engines/t1/report.md', '# Report t1\n\nWritten by the session.\n')
        ConflictTestbed.editLineThree(worktree, 'src/catalog.ts', 'export const catalogPageSize = 30 // session')
        ConflictTestbed.editLineThree(worktree, 'src/wallets.ts', 'export const walletLimit = 300 // session')
      },
      land: (checkout) => {
        ConflictTestbed.write(checkout, '.aidocs/engines/t2/brief.md', '# Brief t2\n\nWritten by another session.\n')
        ConflictTestbed.write(checkout, '.aidocs/engines/t2/report.md', '# Report t2\n\nWritten by another session.\n')
        ConflictTestbed.write(checkout, '.aidocs/engines/t2/trail.md', '# Trail t2\n\nWritten by another session.\n')
        ConflictTestbed.svn(checkout, ['add', '--force', '--', '.aidocs/engines'])
        ConflictTestbed.editLineThree(checkout, 'src/catalog.ts', 'export const catalogPageSize = 40 // incoming')
        ConflictTestbed.editLineThree(checkout, 'src/wallets.ts', 'export const walletLimit = 400 // incoming')
      },
    },
    diverged: {
      session: 'adds `.aidocs/engines/t1/brief.md`; edits line 3 of `src/catalog.ts`',
      incoming: 'adds `.aidocs/engines/t1/brief.md` with different text; edits line 3 of `src/catalog.ts` differently',
      workPaths: ['.aidocs/engines', 'src/catalog.ts'],
      landPaths: ['.aidocs/engines', '.aidocs/engines/t1', '.aidocs/engines/t1/brief.md', 'src/catalog.ts'],
      work: (worktree) => {
        ConflictTestbed.write(worktree, '.aidocs/engines/t1/brief.md', '# Brief t1\n\nThe session wrote this brief.\n')
        ConflictTestbed.editLineThree(worktree, 'src/catalog.ts', 'export const catalogPageSize = 25 // session')
      },
      land: (checkout) => {
        ConflictTestbed.write(checkout, '.aidocs/engines/t1/brief.md', '# Brief t1\n\nAnother session wrote this brief.\n')
        ConflictTestbed.svn(checkout, ['add', '--force', '--', '.aidocs/engines'])
        ConflictTestbed.editLineThree(checkout, 'src/catalog.ts', 'export const catalogPageSize = 35 // incoming')
      },
    },
    text: {
      session: 'edits line 3 of `src/catalog.ts`',
      incoming: 'edits line 3 of `src/catalog.ts` differently',
      workPaths: ['src/catalog.ts'],
      landPaths: ['src/catalog.ts'],
      work: (worktree) => ConflictTestbed.editLineThree(worktree, 'src/catalog.ts', 'export const catalogPageSize = 50 // session'),
      land: (checkout) => ConflictTestbed.editLineThree(checkout, 'src/catalog.ts', 'export const catalogPageSize = 60 // incoming'),
    },
    eol: {
      session: 'the same edit of line 3 of `src/catalog.ts`, with CRLF line ends in the whole file',
      incoming: 'the same edit of line 3 of `src/catalog.ts`, with LF line ends',
      workPaths: ['src/catalog.ts'],
      landPaths: ['src/catalog.ts'],
      work: (worktree) => {
        ConflictTestbed.editLineThree(worktree, 'src/catalog.ts', 'export const catalogPageSize = 24')
        const path = join(worktree, 'src', 'catalog.ts')
        writeFileSync(path, readFileSync(path, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8')
      },
      land: (checkout) => ConflictTestbed.editLineThree(checkout, 'src/catalog.ts', 'export const catalogPageSize = 24'),
    },
    binary: {
      session: 'replaces `assets/logo.png` with the blue image',
      incoming: 'replaces `assets/logo.png` with the same bytes',
      workPaths: ['assets/logo.png'],
      landPaths: ['assets/logo.png'],
      work: (worktree) => ConflictTestbed.writeBytes(worktree, 'assets/logo.png', ConflictTestbed.bluePngConst),
      land: (checkout) => ConflictTestbed.writeBytes(checkout, 'assets/logo.png', ConflictTestbed.bluePngConst),
    },
    props: {
      session: 'adds `dist` to the root `svn:ignore`; sets `jamat:owner` to `testbed` on the root',
      incoming: 'adds `coverage` to the root `svn:ignore`; sets `jamat:owner` to `testbed` on the root',
      workPaths: ['.'],
      landPaths: [''],
      work: (worktree) => {
        ConflictTestbed.propset(worktree, 'svn:ignore', 'node_modules\ndist\n')
        ConflictTestbed.propset(worktree, 'jamat:owner', 'testbed')
      },
      land: (checkout) => {
        ConflictTestbed.propset(checkout, 'svn:ignore', 'node_modules\ncoverage\n')
        ConflictTestbed.propset(checkout, 'jamat:owner', 'testbed')
      },
    },
    delete: {
      session: 'deletes `src/legacy.ts` from disk',
      incoming: 'deletes `src/legacy.ts` with `svn delete`',
      workPaths: ['src/legacy.ts'],
      landPaths: ['src/legacy.ts'],
      work: (worktree) => rmSync(join(worktree, 'src', 'legacy.ts')),
      land: (checkout) => ConflictTestbed.svn(checkout, ['delete', '--', 'src/legacy.ts']),
    },
    kind: {
      session: 'adds a file `docs`',
      incoming: 'adds a directory `docs/` with `docs/index.md`',
      workPaths: ['docs'],
      landPaths: ['docs', 'docs/index.md'],
      work: (worktree) => ConflictTestbed.write(worktree, 'docs', 'The session wrote a file named docs.\n'),
      land: (checkout) => {
        ConflictTestbed.write(checkout, 'docs/index.md', '# Docs\n\nAnother session made docs a directory.\n')
        ConflictTestbed.svn(checkout, ['add', '--force', '--', 'docs'])
      },
    },
  }

  static isScenario(name: string): name is ConflictScenarioName {
    return (ConflictTestbed.scenarioNamesConst as readonly string[]).includes(name)
  }

  static mainOf(root: string): string {
    return join(root, 'main')
  }

  static urlOf(root: string): string {
    return pathToFileURL(join(root, 'repo')).href
  }

  /** `<root>/repo` and `<root>/main` at r1; an earlier testbed in `<root>` is replaced, anything else refused. */
  static build(root: string): void {
    if (existsSync(root) && readdirSync(root).length > 0) {
      if (!existsSync(join(root, ConflictTestbed.markerConst)))
        throw new Error(`${root} exists and is no conflict testbed; choose an empty or new directory`)
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, ConflictTestbed.markerConst), 'Built by scripts/dev/make-conflict-testbed.ts\n', 'utf8')
    ConflictTestbed.invoke('svnadmin', root, ['create', join(root, 'repo')])
    const main = ConflictTestbed.mainOf(root)
    ConflictTestbed.svn(root, ['checkout', ConflictTestbed.urlOf(root), main])
    ConflictTestbed.write(main, 'src/catalog.ts', ConflictTestbed.lines([
      '// The wallet catalog of the start page.',
      "export const catalogTitle = 'Wallet catalog'",
      'export const catalogPageSize = 20',
      "export const catalogSort = 'name'",
    ]))
    ConflictTestbed.write(main, 'src/wallets.ts', ConflictTestbed.lines([
      '// The wallets one account may hold.',
      "export const walletKinds = ['hot', 'cold']",
      'export const walletLimit = 100',
      'export const walletLabel = (name: string) => `Wallet ${name}`',
    ]))
    ConflictTestbed.write(main, 'src/legacy.ts', ConflictTestbed.lines([
      '// Kept only for the old start page.',
      'export const legacyBanner = true',
    ]))
    ConflictTestbed.writeBytes(main, 'assets/logo.png', ConflictTestbed.redPngConst)
    ConflictTestbed.write(main, '.aidocs/README.md', '# AI workflow documents\n\nEngines write their trails below `engines/`.\n')
    ConflictTestbed.svn(main, ['add', '--force', '--', '.'])
    ConflictTestbed.propset(main, 'svn:global-ignores', '.worktrees')
    ConflictTestbed.propset(main, 'svn:ignore', 'node_modules\n')
    ConflictTestbed.svn(main, ['commit', '--username', 'testbed', '-m', 'testbed: r1', '--', '.'])
    ConflictTestbed.svn(main, ['update', '--', '.'])
  }

  /** The session's side, written into `worktree`; nothing is committed. */
  static work(worktree: string, scenario: ConflictScenarioName): void {
    ConflictTestbed.svn(worktree, ['info', '--', '.'])
    ConflictTestbed.scenariosConst[scenario].work(worktree)
  }

  /** The incoming side, committed from `<root>/land`; answers the revision it made. */
  static land(root: string, scenario: ConflictScenarioName): number {
    const checkout = join(root, 'land')
    if (existsSync(checkout)) ConflictTestbed.svn(checkout, ['update', '--', '.'])
    else ConflictTestbed.svn(root, ['checkout', ConflictTestbed.urlOf(root), checkout])
    ConflictTestbed.scenariosConst[scenario].land(checkout)
    const committed = ConflictTestbed.svn(checkout, ['commit', '--username', 'testbed', '-m', `testbed: ${scenario}`, '--', '.'])
    const revision = /Committed revision (\d+)\./.exec(committed)?.[1]
    if (revision === undefined) throw new Error(`svn committed nothing for ${scenario}: ${committed.trim()}`)
    return Number(revision)
  }

  private static lines(lines: readonly string[]): string {
    return `${lines.join('\n')}\n`
  }

  private static editLineThree(root: string, relative: string, text: string): void {
    const path = join(root, ...relative.split('/'))
    const lines = readFileSync(path, 'utf8').split('\n')
    lines[2] = text
    writeFileSync(path, lines.join('\n'), 'utf8')
  }

  private static write(root: string, relative: string, text: string): void {
    const path = join(root, ...relative.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
  }

  private static writeBytes(root: string, relative: string, base64: string): void {
    const path = join(root, ...relative.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(base64, 'base64'))
  }

  /** Through a file: a newline inside a command-line argument does not survive every Windows shell. */
  private static propset(workingCopy: string, name: string, value: string): void {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-conflict-testbed-'))
    try {
      const file = join(directory, 'value.txt')
      writeFileSync(file, value, 'utf8')
      ConflictTestbed.svn(workingCopy, ['propset', name, '-F', file, '--', '.'])
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }

  private static svn(cwd: string, args: readonly string[]): string {
    return ConflictTestbed.invoke('svn', cwd, [args[0] ?? '', '--non-interactive', ...args.slice(1)])
  }

  private static invoke(command: string, cwd: string, args: readonly string[]): string {
    try {
      return execFileSync(command, [...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
    }
    catch (error) {
      const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : String(error)
      throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${detail.trim()}`)
    }
  }
}

class ConflictTestbedCli {
  static run(argv: readonly string[]): void {
    const args = argv.filter((arg) => arg !== '--')
    const root = args[0]
    if (root === undefined || root.startsWith('--')) ConflictTestbedCli.fail('Name the testbed root first.')
    const absolute = resolve(root)
    const mode = args[1]
    if (mode === undefined) {
      ConflictTestbed.build(absolute)
      ConflictTestbedCli.usage(absolute)
    }
    else if (mode === '--work') {
      const worktree = args[2]
      const scenario = ConflictTestbedCli.scenarioOf(args[3])
      if (worktree === undefined) ConflictTestbedCli.fail('--work takes a worktree and a scenario.')
      ConflictTestbed.work(resolve(worktree), scenario)
      console.log(`${scenario}: the session's side is in ${resolve(worktree)}, nothing committed`)
    }
    else if (mode === '--land') {
      const scenario = ConflictTestbedCli.scenarioOf(args[2])
      console.log(`r${ConflictTestbed.land(absolute, scenario)}: ${scenario}`)
    }
    else ConflictTestbedCli.fail(`Unknown argument ${mode}.`)
  }

  private static scenarioOf(name: string | undefined): ConflictScenarioName {
    if (name !== undefined && ConflictTestbed.isScenario(name)) return name
    return ConflictTestbedCli.fail(`Name a scenario: ${ConflictTestbed.scenarioNamesConst.join(', ')}.`)
  }

  private static usage(root: string): void {
    console.log(`main copy: ${ConflictTestbed.mainOf(root)} (r1)`)
    console.log('\nWrite the session\'s side into a worktree, without a commit:')
    console.log(`  pnpm dev:conflict-testbed ${root} --work <worktree> <scenario>`)
    console.log('Commit the incoming side as the next revision:')
    console.log(`  pnpm dev:conflict-testbed ${root} --land <scenario>`)
    console.log('\nScenarios:')
    for (const name of ConflictTestbed.scenarioNamesConst) {
      const scenario = ConflictTestbed.scenariosConst[name]
      console.log(`  ${name.padEnd(9)} session: ${scenario.session}`)
      console.log(`  ${''.padEnd(9)} incoming: ${scenario.incoming}`)
    }
  }

  private static fail(message: string): never {
    console.error(`${message}\nUsage: pnpm dev:conflict-testbed <root> [--work <worktree> <scenario> | --land <scenario>]`)
    process.exit(1)
  }
}

// The smoke imports the class; only a direct run executes the command line.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase())
  ConflictTestbedCli.run(process.argv.slice(2))
