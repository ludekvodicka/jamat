/**
 * Builds the demo profile the release screenshots are captured from: a neutral project tree, a
 * dirty ShopFront working copy, seeded config directories for a main and a peer instance, and the
 * isolated agent homes both instances share.
 *
 *   pnpm dev:demo                       # refuses to touch an existing demo root
 *   pnpm dev:demo -- --force            # rebuilds it
 *   pnpm dev:demo -- --root D:\Demo     # anywhere else; combines with --force
 *
 * `--force` resets what this script owns and NOT the two agent homes. A login is an OAuth grant a
 * human made by hand in a throwaway directory; this script did not create it, so it is not this
 * script's to delete, and preserving it keeps a rebuild from invalidating the runbook's one-time
 * steps.
 *
 * The .private launchers do not ship. Their manual equivalent, for anyone without them:
 *   set JAMAT_V3_CONFIG_DIR=Q:\Demo\.jamat-demo
 *   set CLAUDE_CONFIG_DIR=Q:\Demo\.claude-demo
 *   set CODEX_HOME=Q:\Demo\.codex-demo
 *   pnpm run ui
 *
 * Nothing here fabricates usage data. The rate meters, the model readout and the sessions are live
 * state and come from the runbook's real logins inside those isolated homes; a fabricated
 * credentials file would only put a 401 on the screen.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { RemoteControlListenerSettings } from '../../app-client-ui/shared/remoteControlSettings'

type DemoStack = 'web' | 'backend' | 'ai' | 'home'

interface DemoProject {
  readonly name: string
  readonly description: string
}

interface DemoCategory {
  /** Category id in config.json. */
  readonly id: string
  /** Selector label AND the on-disk folder name under the demo root. */
  readonly label: string
  readonly stack: DemoStack
  readonly projects: readonly DemoProject[]
}

class MakeDemoProfile {
  private static readonly repositoryRootConst = fileURLToPath(new URL('../../', import.meta.url))
  private static readonly templateRootConst
    = join(MakeDemoProfile.repositoryRootConst, 'configs', 'demo', 'tree')
  /** V1's path, chosen over a more neutral one knowing the drive letter shows in every shot. */
  private static readonly demoRootDefaultConst = 'Q:\\Demo'

  private static readonly categoriesConst: readonly DemoCategory[] = [
    {
      id: 'web',
      label: 'ApplicationsWeb',
      stack: 'web',
      projects: [
        { name: 'ShopFront', description: 'Customer-facing storefront with cart and checkout.' },
        { name: 'AdminDashboard', description: 'Internal admin panel for orders, users and metrics.' },
        { name: 'PortfolioSite', description: 'Marketing and portfolio site with a CMS-driven blog.' },
        { name: 'BlogPlatform', description: 'Multi-author publishing platform with MDX articles.' },
      ],
    },
    {
      id: 'backend',
      label: 'ApplicationsBackend',
      stack: 'backend',
      projects: [
        { name: 'AuthService', description: 'JWT auth, sessions and role-based access control.' },
        { name: 'PaymentGateway', description: 'Payment intents, webhooks and reconciliation.' },
        { name: 'NotificationWorker', description: 'Queue-driven email and push notification dispatcher.' },
        { name: 'ApiGateway', description: 'Edge router, rate limiting and request aggregation.' },
      ],
    },
    {
      id: 'ai',
      label: 'ApplicationsAI',
      stack: 'ai',
      projects: [
        { name: 'ChatAssistant', description: 'Streaming chat assistant over a tool-calling loop.' },
        { name: 'DocSummarizer', description: 'Long-document chunking and map-reduce summaries.' },
        { name: 'ImageTagger', description: 'Vision pipeline that auto-tags an image library.' },
        { name: 'RagPipeline', description: 'Embeddings, vector search and grounded answers.' },
      ],
    },
    {
      id: 'house',
      label: 'House',
      stack: 'home',
      projects: [
        { name: 'Pool', description: 'Backyard pool build - quotes, permits, pump and maintenance notes.' },
        { name: 'Garden', description: 'Garden landscaping - beds, irrigation and a planting calendar.' },
        { name: 'Electrics', description: 'House rewiring - circuit inventory, quotes and safety checks.' },
        { name: 'Renovation', description: 'Kitchen renovation - measurements, contractor bids and a task list.' },
        { name: 'Heating', description: 'Heat-pump install - quotes, sizing and running-cost notes.' },
      ],
    },
  ]

  /** The one project that gets a real git and svn history and a dirty status (shot 03). */
  private static readonly dirtyProjectConst = { category: 'ApplicationsWeb', name: 'ShopFront' }
  private static readonly mainListenerPortConst = 47150
  private static readonly peerListenerPortConst = 47160
  private static readonly claudeHomeConst = '.claude-demo'
  private static readonly codexHomeConst = '.codex-demo'
  private static readonly supportConst = '.demo-support'
  private static readonly mainConfigDirConst = '.jamat-demo'
  private static readonly peerConfigDirConst = '.jamat-demo-peer'

  /** Kept across `--force`: see the header. Everything else under the demo root is generated. */
  private static readonly preservedEntriesConst: readonly string[] = [
    MakeDemoProfile.claudeHomeConst,
    MakeDemoProfile.codexHomeConst,
  ]

  /**
   * Both systems record this, and File Changes shows the author of every revision it lists - which
   * is a column in the screenshot this fixture exists for. One constant, because a Git author and
   * an SVN author that drifted apart would put two different names in the same history panel.
   */
  private static readonly demoAuthorConst = 'Jamat Demo'

  /**
   * Committed content is authored by the fixture, never by whoever runs it: the agent shell exports
   * GIT_AUTHOR_*, and an env identity outranks repository config.
   */
  private static readonly gitEnvConst: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: MakeDemoProfile.demoAuthorConst,
    GIT_AUTHOR_EMAIL: 'demo@jamat.invalid',
    GIT_COMMITTER_NAME: MakeDemoProfile.demoAuthorConst,
    GIT_COMMITTER_EMAIL: 'demo@jamat.invalid',
  }

  /** Placeholder substitution runs on these and nothing else, so a future binary template survives. */
  private static readonly textExtensionsConst: ReadonlySet<string> = new Set([
    '.css', '.html', '.js', '.json', '.jsx', '.md', '.mdext', '.py', '.toml', '.ts', '.tsx',
    '.txt', '.yaml', '.yml',
  ])

  private static demoRoot = MakeDemoProfile.demoRootDefaultConst
  private static svnAvailable = true

  static run(): void {
    const { root, force } = MakeDemoProfile.parseArguments(process.argv.slice(2))
    MakeDemoProfile.demoRoot = root

    if (existsSync(root) && !force) {
      console.error(`${root} already exists. Re-run with --force to rebuild it.`)
      process.exit(1)
    }
    MakeDemoProfile.assertTools()
    console.log(`building the demo profile in ${root}, this takes a few seconds`)
    MakeDemoProfile.resetRoot()

    for (const category of MakeDemoProfile.categoriesConst)
      for (const project of category.projects)
        MakeDemoProfile.instantiate(category, project)

    MakeDemoProfile.seedVcs()
    MakeDemoProfile.seedConfig(MakeDemoProfile.mainConfigDirConst, MakeDemoProfile.mainConfig())
    MakeDemoProfile.seedConfig(MakeDemoProfile.peerConfigDirConst, MakeDemoProfile.peerConfig())
    mkdirSync(join(root, MakeDemoProfile.claudeHomeConst), { recursive: true })
    mkdirSync(join(root, MakeDemoProfile.codexHomeConst), { recursive: true })
    MakeDemoProfile.report()
  }

  private static parseArguments(argv: readonly string[]): { root: string; force: boolean } {
    let root = MakeDemoProfile.demoRootDefaultConst
    let force = false
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index]
      if (argument === '--force') {
        force = true
        continue
      }
      if (argument === '--root') {
        const value = argv[index + 1]
        if (value === undefined || value.startsWith('--'))
          throw new Error('--root needs a directory')
        root = value
        index++
        continue
      }
      throw new Error(`unknown argument ${argument}; expected --force or --root <dir>`)
    }
    return { root, force }
  }

  private static assertTools(): void {
    try { MakeDemoProfile.invoke('git', MakeDemoProfile.repositoryRootConst, ['--version']) }
    catch { throw new Error('git is not on PATH; the demo profile needs Git') }

    for (const tool of ['svn', 'svnadmin']) {
      try { MakeDemoProfile.invoke(tool, MakeDemoProfile.repositoryRootConst, ['--version']) }
      catch {
        MakeDemoProfile.svnAvailable = false
        console.warn(`${tool} is not on PATH: ShopFront gets a Git history only, everything else is built`)
        return
      }
    }
  }

  /**
   * Not `rmSync(root)`: the two agent homes are kept. Removing entry by entry also leaves an
   * existing root in place rather than recreating it, which matters because one of the things
   * inside it is a login.
   */
  private static resetRoot(): void {
    if (!existsSync(MakeDemoProfile.demoRoot)) {
      mkdirSync(MakeDemoProfile.demoRoot, { recursive: true })
      return
    }
    for (const entry of readdirSync(MakeDemoProfile.demoRoot)) {
      if (MakeDemoProfile.preservedEntriesConst.includes(entry)) continue
      rmSync(join(MakeDemoProfile.demoRoot, entry), { recursive: true, force: true })
    }
  }

  /** Stack skeleton, then the placeholders, then the per-project overlay when one exists. */
  private static instantiate(category: DemoCategory, project: DemoProject): void {
    const target = join(MakeDemoProfile.demoRoot, category.label, project.name)
    cpSync(join(MakeDemoProfile.templateRootConst, 'stacks', category.stack), target, { recursive: true })
    MakeDemoProfile.substitute(target, project)

    const overlay = join(MakeDemoProfile.templateRootConst, 'projects', project.name)
    if (!existsSync(overlay)) return
    cpSync(overlay, target, { recursive: true })
    MakeDemoProfile.substitute(target, project)
  }

  private static substitute(directory: string, project: DemoProject): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        MakeDemoProfile.substitute(path, project)
        continue
      }
      if (!MakeDemoProfile.textExtensionsConst.has(extname(entry.name))) continue
      const content = readFileSync(path, 'utf8')
        .replaceAll('{{nameLower}}', project.name.toLowerCase())
        .replaceAll('{{name}}', project.name)
        .replaceAll('{{description}}', project.description)
      writeFileSync(path, content, 'utf8')
    }
  }

  /**
   * Two committed baselines and a dirty working copy in ShopFront, in Git and - when the SVN
   * command line tools are there - in SVN too, so File Changes can be shown against either
   * baseline. The technique is `make-file-viewer-testbed.ts`'s; the content is not, because that
   * fixture is test material and carries its own name in the breadcrumb.
   */
  private static seedVcs(): void {
    const project = MakeDemoProfile.projectPath()

    if (MakeDemoProfile.svnAvailable) {
      const support = join(MakeDemoProfile.demoRoot, MakeDemoProfile.supportConst)
      const repository = join(support, 'svn-repository')
      mkdirSync(support, { recursive: true })
      MakeDemoProfile.invoke('svnadmin', support, ['create', repository])
      // The project directory already holds the templated content; r0 is empty, so the checkout
      // brings nothing that could conflict with it.
      MakeDemoProfile.svn(MakeDemoProfile.demoRoot,
        ['checkout', pathToFileURL(repository).href, project])
      // Set before the first add: an ignore that arrives later leaves .git already versioned.
      const ignoreFile = join(support, 'svn-ignore.txt')
      writeFileSync(ignoreFile, '.git\n', 'utf8')
      MakeDemoProfile.svn(project, ['propset', 'svn:ignore', '-F', ignoreFile, '.'])
    }

    MakeDemoProfile.write('.gitignore', '.svn/\n')
    MakeDemoProfile.firstBaseline()
    MakeDemoProfile.secondBaseline()
    MakeDemoProfile.dirtyWorkingCopy()
  }

  private static firstBaseline(): void {
    if (MakeDemoProfile.svnAvailable) {
      MakeDemoProfile.svn(MakeDemoProfile.projectPath(), ['add', '--force', '.'])
      MakeDemoProfile.commitSvn('Initial storefront')
    }
    MakeDemoProfile.git(['init', '-b', 'main'])
    MakeDemoProfile.git(['add', '-A'])
    MakeDemoProfile.git(['commit', '-m', 'Initial storefront'])
  }

  /** A second revision, so the history the app pages through has more than one entry in it. */
  private static secondBaseline(): void {
    MakeDemoProfile.edit('package.json', '"version": "0.3.0"', '"version": "0.3.1"')
    if (MakeDemoProfile.svnAvailable) MakeDemoProfile.commitSvn('Bump the version to 0.3.1')
    MakeDemoProfile.git(['add', '-A'])
    MakeDemoProfile.git(['commit', '-m', 'Bump the version to 0.3.1'])
  }

  /**
   * Modest and plausible: three edits, one rename and one new file. The order is not arbitrary -
   * the rename is staged BEFORE the new file is written, so the new file stays untracked in both
   * systems instead of being swept in by the same `git add`.
   */
  private static dirtyWorkingCopy(): void {
    MakeDemoProfile.edit('README.md',
      '- `src/components` - shared UI components',
      '- `src/components` - shared UI components\n- `src/app/api` - route handlers (planned)')
    MakeDemoProfile.edit('src/components/hero.tsx',
      '      <p>{subtitle}</p>\n',
      '      <p>{subtitle}</p>\n      <a className="hero-cta" href="/catalogue">Browse the catalogue</a>\n')

    if (MakeDemoProfile.svnAvailable) {
      MakeDemoProfile.svn(MakeDemoProfile.projectPath(),
        ['move', 'src/components/banner.tsx', 'src/components/promoBanner.tsx'])
      // `svn move` moves the file on disk and leaves Git's index alone, so Git is told separately.
      // The `git mv` branch below needs no such call: it stages both halves itself, and a second
      // add would then fail on a path that no longer exists and is no longer tracked.
      MakeDemoProfile.git(['add', '-A', 'src/components/banner.tsx', 'src/components/promoBanner.tsx'])
    }
    else {
      MakeDemoProfile.git(['mv', 'src/components/banner.tsx', 'src/components/promoBanner.tsx'])
    }
    // The import has to follow the file, or the working copy is a rename nobody would have made.
    MakeDemoProfile.edit('src/app/page.tsx',
      "from '../components/banner'", "from '../components/promoBanner'")

    MakeDemoProfile.write('src/components/discountBadge.tsx',
      'export function DiscountBadge({ percent }: { percent: number }) {\n'
      + '  return <span className="discount-badge">{percent}% off</span>\n'
      + '}\n')
  }

  private static seedConfig(directory: string, document: unknown): void {
    const target = join(MakeDemoProfile.demoRoot, directory)
    mkdirSync(target, { recursive: true })
    // config-identity.json is deliberately not written: ConfigIdentityStore creates it with the
    // development channel on first run, which is exactly what satisfies the channel guard.
    writeFileSync(join(target, 'config.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }

  /**
   * All four listener keys, even though this one does not listen. The section validator reads the
   * listener whole and a partial one makes the ENTIRE remoteControl section damaged, which locks the
   * Remote Control screen behind "repaired by hand" on a profile the screenshots are taken from.
   * That is what `{ enabled: false }` alone did here until 2026-09-07, and what the parameter type
   * below now prevents: it was `unknown`, so the compiler had nothing to check the literal against.
   */
  private static mainConfig(): unknown {
    return MakeDemoProfile.configDocument({
      enabled: false,
      bindHost: '127.0.0.1',
      port: MakeDemoProfile.mainListenerPortConst,
      advertisedHost: '127.0.0.1',
    })
  }

  /** The peer differs in one thing only: it listens, on loopback. */
  private static peerConfig(): unknown {
    return MakeDemoProfile.configDocument({
      enabled: true,
      bindHost: '127.0.0.1',
      port: MakeDemoProfile.peerListenerPortConst,
      advertisedHost: '127.0.0.1',
    })
  }

  private static configDocument(listener: RemoteControlListenerSettings): unknown {
    return {
      schemaVersion: 1,
      categories: MakeDemoProfile.categoriesConst.map((category) => ({
        id: category.id,
        label: category.label,
        path: `${MakeDemoProfile.demoRoot.replaceAll('\\', '/')}/${category.label}`,
        hiddenFolders: ['node_modules'],
      })),
      ui: {
        fontScalePercent: 115,
        fileViewerFontScalePercent: 115,
        terminalFontScalePercent: 115,
        terminalTheme: 'soft',
      },
      fileChanges: { primaryVcs: 'git' },
      agents: {
        claude: { yolo: true, autoCompactEnabled: true },
        codex: { yolo: true, autoCompactEnabled: true },
      },
      // Deliberately no `remarkable` section: the real one carries a LAN host and an SSH
      // fingerprint, and nothing seeded here may identify a machine.
      remoteControl: { listener, profiles: [] },
    }
  }

  private static report(): void {
    const root = MakeDemoProfile.demoRoot
    const claudeHome = join(root, MakeDemoProfile.claudeHomeConst)
    const loggedIn = existsSync(join(claudeHome, '.credentials.json'))

    console.log(`\ndemo root:    ${root}`)
    console.log(`main config:  ${join(root, MakeDemoProfile.mainConfigDirConst)}`)
    console.log(`peer config:  ${join(root, MakeDemoProfile.peerConfigDirConst)} (listener on 127.0.0.1:${MakeDemoProfile.peerListenerPortConst})`)
    console.log(`claude home:  ${claudeHome}${loggedIn ? ' (a login is already there)' : ' (empty: the runbook logs in once)'}`)
    console.log(`codex home:   ${join(root, MakeDemoProfile.codexHomeConst)}`)

    // trimEnd, never trim: the first column of a short status is significant, and a leading trim
    // turns a worktree change into what reads like a staged one.
    console.log(`\ngit status --short\n${MakeDemoProfile.git(['status', '--short']).trimEnd()}`)
    if (MakeDemoProfile.svnAvailable)
      console.log(`\nsvn status\n${MakeDemoProfile.svn(MakeDemoProfile.projectPath(), ['status']).trim()}`)

    console.log('\nNext: .private/docs/demo-profile.md - the one-time logins, the peer pairing, and'
      + ' the per-shot checklist.')
  }

  private static projectPath(): string {
    return join(MakeDemoProfile.demoRoot,
      MakeDemoProfile.dirtyProjectConst.category, MakeDemoProfile.dirtyProjectConst.name)
  }

  private static write(relativePath: string, content: string): void {
    writeFileSync(join(MakeDemoProfile.projectPath(), relativePath), content, 'utf8')
  }

  /** A replacement that silently matches nothing would leave a fixture that looks built and is not. */
  private static edit(relativePath: string, from: string, to: string): void {
    const path = join(MakeDemoProfile.projectPath(), relativePath)
    const before = readFileSync(path, 'utf8')
    if (!before.includes(from))
      throw new Error(`${relativePath} does not contain ${JSON.stringify(from)}`)
    writeFileSync(path, before.replace(from, to), 'utf8')
  }

  private static git(args: readonly string[]): string {
    return MakeDemoProfile.invoke('git', MakeDemoProfile.projectPath(), args,
      { ...process.env, ...MakeDemoProfile.gitEnvConst })
  }

  /**
   * The update is not tidiness. A commit bumps only the paths it touched, so the working copy root
   * stays at the older revision, and `svn log .` pegs on the root: without the update the second
   * revision is missing from the history the app pages through.
   */
  private static commitSvn(message: string): void {
    MakeDemoProfile.svn(MakeDemoProfile.projectPath(), ['commit', '-m', message])
    MakeDemoProfile.svn(MakeDemoProfile.projectPath(), ['update'])
  }

  /**
   * `--username` is what pins the SVN author. A `file://` repository authenticates nobody, so
   * without it every revision is recorded under the OS account of whoever ran the script - the one
   * name this whole fixture exists to keep off the screen.
   */
  private static svn(cwd: string, args: readonly string[]): string {
    return MakeDemoProfile.invoke('svn', cwd,
      [...args, '--username', MakeDemoProfile.demoAuthorConst, '--non-interactive'])
  }

  private static invoke(
    command: string,
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    try {
      return execFileSync(command, [...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' })
    }
    catch (error) {
      const detail = error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error)
      throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${detail}`)
    }
  }
}

try { MakeDemoProfile.run() }
catch (error) {
  console.error(`make-demo-profile: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
