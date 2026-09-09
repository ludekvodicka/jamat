/**
 * Builds the manual acceptance testbed for FileViewer and File Changes. The result is ONE working
 * copy that is at the same time a Git repository and an SVN working copy, holding every document
 * kind the format registry knows, a deliberately dirty status, a rename in the working copy and a
 * second rename in history.
 *
 * It is here rather than in scripts/smoke/ because nothing about it is a gate: it produces a tree
 * for a human to click through, and the paths it covers are the ones the harness cannot reach.
 *
 *   pnpm dev:testbed              # refuses to touch an existing testbed
 *   pnpm dev:testbed -- --force   # deletes it and builds it again
 *
 * The documents come from configs/testbed/tree/. Binaries, media and the oversized log are
 * generated here, because a fixture that carries them would be committed noise in this repository.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

class MakeFileViewerTestbed {
  private static readonly repositoryRootConst = fileURLToPath(new URL('../../', import.meta.url))
  private static readonly templateRootConst
    = join(MakeFileViewerTestbed.repositoryRootConst, 'configs', 'testbed', 'tree')
  /**
   * `.testbed` is the CATEGORY root the user registers, and the project sits one level inside it.
   * The launcher's scanner skips every directory whose name begins with a dot, so a project named
   * `.testbed` could never be opened; a dotted root holding one plainly named project keeps the
   * fixture out of every other scan and still gives that category exactly one entry.
   */
  private static readonly categoryRootConst = join(MakeFileViewerTestbed.repositoryRootConst, '.testbed')
  private static readonly testbedConst
    = join(MakeFileViewerTestbed.categoryRootConst, 'FileViewerTestbed')
  private static readonly supportConst = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'jamat-v3-testbed',
  )
  private static readonly bigLogBytesConst = 2_600_000
  private static readonly sampleBinBytesConst = 320 * 1024

  /**
   * Committed content is authored by the fixture, never by whoever runs it: Claude's shell exports
   * GIT_AUTHOR_*, and an env identity outranks repository config, so the fixture would otherwise
   * record a different author on every machine.
   */
  private static readonly gitEnvConst: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: 'Jamat Testbed',
    GIT_AUTHOR_EMAIL: 'testbed@jamat.invalid',
    GIT_COMMITTER_NAME: 'Jamat Testbed',
    GIT_COMMITTER_EMAIL: 'testbed@jamat.invalid',
  }

  private static ffmpeg = true

  static run(): void {
    const force = process.argv.slice(2).includes('--force')
    // The CATEGORY root, not the project inside it: the two `rmSync` calls below take the whole
    // category and the support directory, so guarding the project alone meant that a category
    // holding a second project the launcher created - and nothing else - was deleted by a plain
    // run, as soon as the testbed project itself happened to be missing.
    if (existsSync(MakeFileViewerTestbed.categoryRootConst) && !force) {
      console.error(`${MakeFileViewerTestbed.categoryRootConst} already exists. Re-run with --force to replace it.`)
      process.exit(1)
    }
    MakeFileViewerTestbed.assertTools()
    console.log('building the testbed, this takes a few seconds')
    rmSync(MakeFileViewerTestbed.categoryRootConst, { recursive: true, force: true })
    rmSync(MakeFileViewerTestbed.supportConst, { recursive: true, force: true })
    mkdirSync(MakeFileViewerTestbed.categoryRootConst, { recursive: true })

    MakeFileViewerTestbed.seedSvnRepository()
    MakeFileViewerTestbed.seedContent()
    MakeFileViewerTestbed.firstBaseline()
    MakeFileViewerTestbed.secondBaseline()
    MakeFileViewerTestbed.gitOnlyCommit()
    MakeFileViewerTestbed.dirtyWorkingCopy()
    MakeFileViewerTestbed.createLinks()
    MakeFileViewerTestbed.report()
  }

  private static assertTools(): void {
    for (const tool of ['git', 'svn', 'svnadmin']) {
      try { MakeFileViewerTestbed.invoke(tool, MakeFileViewerTestbed.repositoryRootConst, ['--version']) }
      catch { throw new Error(`${tool} is not on PATH; the testbed needs Git and the SVN command line tools`) }
    }
    try { MakeFileViewerTestbed.invoke('ffmpeg', MakeFileViewerTestbed.repositoryRootConst, ['-version']) }
    catch {
      MakeFileViewerTestbed.ffmpeg = false
      console.warn('ffmpeg is not on PATH: images and video are skipped, everything else is built')
    }
  }

  private static seedSvnRepository(): void {
    const repository = join(MakeFileViewerTestbed.supportConst, 'svn-repository')
    mkdirSync(MakeFileViewerTestbed.supportConst, { recursive: true })
    mkdirSync(join(MakeFileViewerTestbed.supportConst, 'external'), { recursive: true })
    writeFileSync(
      join(MakeFileViewerTestbed.supportConst, 'external', 'external-notes.md'),
      '# External notes\n\nThis file lives OUTSIDE the testbed working directory. A transcript that\n'
      + 'mutates it is what produces an external entry with chat attribution.\n',
      'utf8',
    )
    MakeFileViewerTestbed.invoke('svnadmin', MakeFileViewerTestbed.supportConst, ['create', repository])
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.repositoryRootConst, [
      'checkout', pathToFileURL(repository).href, MakeFileViewerTestbed.testbedConst,
    ])
  }

  private static seedContent(): void {
    cpSync(MakeFileViewerTestbed.templateRootConst, MakeFileViewerTestbed.testbedConst, { recursive: true })
    // `data` sits in the user's global excludes, and a repository rule is the only thing that
    // outranks it: without the negation `git add` silently skips the two files the diff limits
    // are demonstrated on, and the fixture looks built while missing them.
    MakeFileViewerTestbed.write('.gitignore', '.svn/\nlinks/\n!/data/\n')

    mkdirSync(MakeFileViewerTestbed.path('docs/empty'), { recursive: true })
    mkdirSync(MakeFileViewerTestbed.path('binary'), { recursive: true })
    mkdirSync(MakeFileViewerTestbed.path('media'), { recursive: true })

    MakeFileViewerTestbed.write('binary/not-really.png', 'This is plain text wearing an image extension.\n'
      + 'Preview has nothing to show; Hex shows letters where a PNG signature belongs.\n')
    MakeFileViewerTestbed.write('binary/broken.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
      + '  <rect x="4" y="4" width="56" height="56"\n'
      + '</svg>\n')
    writeFileSync(
      MakeFileViewerTestbed.path('binary/broken-text.txt'),
      Buffer.from('This file claims to be text.\x00\x00But it carries NUL bytes, so it is Hex.\n', 'latin1'),
    )
    writeFileSync(MakeFileViewerTestbed.path('binary/sample.bin'), MakeFileViewerTestbed.sampleBytes())
    MakeFileViewerTestbed.write('data/big-app.log', MakeFileViewerTestbed.bigLog())
    MakeFileViewerTestbed.media()
  }

  /**
   * Every byte value in order, so the ASCII column has both printable runs and dots, with a marker
   * at each 64 KiB boundary: the page the viewer fetches is exactly that size, so a wrong page shows
   * the wrong banner instead of looking plausible.
   */
  private static sampleBytes(): Buffer {
    const bytes = Buffer.alloc(MakeFileViewerTestbed.sampleBinBytesConst)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
    for (let page = 0; page * 65_536 < bytes.length; page++)
      bytes.write(`PAGE ${page} STARTS AT OFFSET ${page * 65_536} `, page * 65_536, 'latin1')
    return bytes
  }

  private static bigLog(): string {
    const lines: string[] = ['# Over 2 MiB on purpose: the viewer must page it as Hex, and the diff must refuse it.\n']
    let size = lines[0]?.length ?? 0
    for (let index = 0; size < MakeFileViewerTestbed.bigLogBytesConst; index++) {
      const line = `2026-08-17T09:${String(index % 60).padStart(2, '0')}:00.000Z INFO  worker    `
        + `record ${index} processed, queue depth ${index % 97}, latency ${index % 250} ms\n`
      lines.push(line)
      size += line.length
    }
    return lines.join('')
  }

  private static media(): void {
    if (!MakeFileViewerTestbed.ffmpeg) return
    const assets = MakeFileViewerTestbed.path('assets')
    const media = MakeFileViewerTestbed.path('media')
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=1', '-frames:v', '1',
      join(assets, 'logo.png')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-frames:v', '1',
      join(assets, 'photo.jpg')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2',
      join(assets, 'animated.gif')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'smptebars=size=200x200:rate=1', '-frames:v', '1',
      join(assets, 'sample.webp')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc=size=200x200:rate=1', '-frames:v', '1',
      join(assets, 'sample.bmp')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '4',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(media, 'clip.mp4')])
    MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '4',
      '-c:v', 'libvpx', '-b:v', '400k', join(media, 'clip.webm')])
  }

  private static firstBaseline(): void {
    // Set before the first add: an ignore that arrives later leaves the junctions already versioned.
    // The value goes in through a file because the property is multi-line and an argv newline does
    // not survive the Windows command line intact.
    const ignoreFile = join(MakeFileViewerTestbed.supportConst, 'svn-ignore.txt')
    writeFileSync(ignoreFile, '.git\nlinks\n', 'utf8')
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['propset', 'svn:ignore', '-F', ignoreFile, '.'])
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['add', '--force', '.'])
    MakeFileViewerTestbed.commitSvn('Initial testbed content')
    MakeFileViewerTestbed.git(['init', '-b', 'main'])
    MakeFileViewerTestbed.git(['add', '-A'])
    MakeFileViewerTestbed.git(['commit', '-m', 'Initial testbed content'])
  }

  /**
   * One rename plus one edit, committed to BOTH systems, so a history group has something other
   * than a plain modification in it. SVN carries the copied-from path in its log, which is the only
   * place its rename source ever appears.
   */
  private static secondBaseline(): void {
    MakeFileViewerTestbed.edit('docs/notes.md', '- druhá poznámka\n',
      '- druhá poznámka\n- třetí poznámka, přidaná ve druhé revizi\n')
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst,
      ['move', 'src/legacy/historyRename.ts', 'src/legacy/renamedInHistory.ts'])
    MakeFileViewerTestbed.commitSvn('Second revision: a note and a committed rename')
    MakeFileViewerTestbed.git(['add', '-A'])
    MakeFileViewerTestbed.git(['commit', '-m', 'Second commit: a note and a committed rename'])
  }

  /** Committed to Git alone, so switching primaryVcs visibly changes the listing. */
  private static gitOnlyCommit(): void {
    MakeFileViewerTestbed.write('src/gitOnly.ts',
      '/**\n'
      + ' * Committed in Git, never committed in SVN. Git reports a clean file here; SVN reports an\n'
      + ' * unversioned one. Switching primaryVcs in the settings is what shows the difference.\n'
      + ' */\n'
      + 'export class GitOnly {\n'
      + "  static readonly reason = 'in the third git commit, in no svn revision'\n"
      + '}\n')
    MakeFileViewerTestbed.git(['add', '-A'])
    MakeFileViewerTestbed.git(['commit', '-m', 'Third commit: a file SVN never sees'])
  }

  private static dirtyWorkingCopy(): void {
    MakeFileViewerTestbed.edit('src/app.ts', "versionConst = '1.0.0'", "versionConst = '1.2.0'")
    MakeFileViewerTestbed.edit('src/app.ts', 'const greeting = `hello, ${name}`',
      'const trimmed = name.trim()\n    const greeting = `hello, ${trimmed}`')
    MakeFileViewerTestbed.edit('src/app.ts', 'return Date.now() - this.started',
      'return Math.max(0, Date.now() - this.started)')
    MakeFileViewerTestbed.edit('src/app.ts', '      greetings: this.greetings.length,',
      '      greetings: this.greetings.length,\n      uptimeMs: this.uptimeMs(),')

    MakeFileViewerTestbed.edit('docs/plain.md', '3. řádek tři, tenhle se mění',
      '3. řádek tři, změněný v pracovní kopii')

    // Staged and then modified again, which is the only way to get Git's two-letter MM state.
    MakeFileViewerTestbed.edit('data/report.csv', '2026-08-17,AppJamatV3,19,18,1',
      '2026-08-17,AppJamatV3,23,21,2')
    MakeFileViewerTestbed.git(['add', 'data/report.csv'])
    MakeFileViewerTestbed.append('data/report.csv', '2026-08-18,AppJamatV3,4,4,0\n')

    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst,
      ['move', 'src/legacy/movedFile.ts', 'src/legacy/renamedFile.ts'])
    MakeFileViewerTestbed.git(['add', 'src/legacy'])

    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['delete', 'src/removed.ts'])

    MakeFileViewerTestbed.write('docs/untracked.md',
      '# Nesledovaný soubor\n\nNení ani v gitu, ani v SVN. Obě strany ho hlásí jako nový.\n')
    mkdirSync(MakeFileViewerTestbed.path('src/feature'), { recursive: true })
    MakeFileViewerTestbed.write('src/feature/index.ts',
      "export { Helper } from './helper'\n")
    MakeFileViewerTestbed.write('src/feature/helper.ts',
      'export class Helper {\n'
      + '  static describe(): string {\n'
      + "    return 'a new directory, so the listing synthesises a directory row for it'\n"
      + '  }\n'
      + '}\n')

    MakeFileViewerTestbed.append('data/big-app.log',
      '2026-08-18T00:00:00.000Z WARN  worker    appended after the baseline, so the diff is over its limit\n')
    const sample = readFileSync(MakeFileViewerTestbed.path('binary/sample.bin'))
    sample.write('MODIFIED IN THE WORKING COPY ', 512, 'latin1')
    writeFileSync(MakeFileViewerTestbed.path('binary/sample.bin'), sample)
    if (MakeFileViewerTestbed.ffmpeg)
      MakeFileViewerTestbed.ffmpegRun(['-f', 'lavfi', '-i', 'smptebars=size=320x200:rate=1', '-frames:v', '1',
        MakeFileViewerTestbed.path('assets/logo.png')])
  }

  /**
   * Junctions, not symlinks: a directory junction needs no elevation and no developer mode, and the
   * directory reader resolves both the same way. One points inside the root and stays openable, one
   * points out of it and has to come back disabled.
   */
  private static createLinks(): void {
    const links = MakeFileViewerTestbed.path('links')
    mkdirSync(links, { recursive: true })
    MakeFileViewerTestbed.junction(join(links, 'inside-link'), MakeFileViewerTestbed.path('docs'))
    MakeFileViewerTestbed.junction(join(links, 'outside-junction'),
      join(MakeFileViewerTestbed.supportConst, 'external'))
  }

  private static junction(link: string, target: string): void {
    try {
      execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'mklink', '/J', link, target],
        { stdio: 'pipe' })
    }
    catch (error) {
      console.warn(`could not create the junction ${link}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private static report(): void {
    const status = MakeFileViewerTestbed.git(['status', '--short'])
    console.log(`\nproject root: ${MakeFileViewerTestbed.categoryRootConst}`)
    console.log(`project:      ${MakeFileViewerTestbed.testbedConst}`)
    console.log(`support:      ${MakeFileViewerTestbed.supportConst}`)
    console.log(`external:     ${join(MakeFileViewerTestbed.supportConst, 'external', 'external-notes.md')}`)
    // trimEnd, never trim: the first column of a short status is significant, and a leading trim
    // turns a worktree change into what reads like a staged one.
    console.log(`\ngit status --short\n${status.trimEnd()}`)
    console.log(`\nsvn status\n${MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['status']).trim()}`)
    console.log('\nRegister the project root above in the configuration overlay, open'
      + ' FileViewerTestbed and follow its README.mdext.')
  }

  private static path(relativePath: string): string {
    return join(MakeFileViewerTestbed.testbedConst, relativePath)
  }

  private static write(relativePath: string, content: string): void {
    writeFileSync(MakeFileViewerTestbed.path(relativePath), content, 'utf8')
  }

  private static append(relativePath: string, content: string): void {
    const path = MakeFileViewerTestbed.path(relativePath)
    writeFileSync(path, readFileSync(path, 'utf8') + content, 'utf8')
  }

  /** A replacement that silently matches nothing would leave a fixture that looks built and is not. */
  private static edit(relativePath: string, from: string, to: string): void {
    const path = MakeFileViewerTestbed.path(relativePath)
    const before = readFileSync(path, 'utf8')
    if (!before.includes(from))
      throw new Error(`${relativePath} does not contain ${JSON.stringify(from)}`)
    writeFileSync(path, before.replace(from, to), 'utf8')
  }

  private static git(args: readonly string[]): string {
    return MakeFileViewerTestbed.invoke('git', MakeFileViewerTestbed.testbedConst, args,
      { ...process.env, ...MakeFileViewerTestbed.gitEnvConst })
  }

  /**
   * The update is not tidiness. A commit bumps only the paths it touched, so the working copy root
   * stays at the older revision, and `svn log .` pegs on the root: without the update the second
   * revision is missing from the history the app pages through.
   */
  private static commitSvn(message: string): void {
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['commit', '-m', message])
    MakeFileViewerTestbed.svn(MakeFileViewerTestbed.testbedConst, ['update'])
  }

  private static svn(cwd: string, args: readonly string[]): string {
    return MakeFileViewerTestbed.invoke('svn', cwd, [...args, '--non-interactive'])
  }

  private static ffmpegRun(args: readonly string[]): void {
    MakeFileViewerTestbed.invoke('ffmpeg', MakeFileViewerTestbed.testbedConst,
      ['-y', '-hide_banner', '-loglevel', 'error', ...args])
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

try { MakeFileViewerTestbed.run() }
catch (error) {
  console.error(`make-file-viewer-testbed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
