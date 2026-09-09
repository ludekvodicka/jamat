/**
 * Writes `THIRD-PARTY.md`, the attribution notice for everything a Jamat installer carries that
 * somebody else wrote.
 *
 * **The file is generated, never edited.** A hand-written attribution notice is wrong the first time
 * a dependency moves and nobody notices, which is exactly what happened to the previous generation:
 * its notice named three files while the installer shipped React, dockview, xterm, ws and the whole
 * Electron runtime. `release.sh` regenerates this file and refuses to release when the committed
 * copy differs, so the output has to be byte-identical for an unchanged tree - every list here is
 * sorted and nothing carries a timestamp.
 *
 * The input is three production dependency graphs, read with `pnpm licenses list --json --prod`:
 *
 *   app-client-ui     what electron-builder packs into the installer
 *   app-host          what `release:host-bundle` collapses into the packaged Host
 *   lib-orchestrator  the library both clients link, bundled into the client's main process
 *
 * plus three runtimes that no npm graph names because they arrive as archives: Electron, the Node
 * the reMarkable sidecar runs on, and the sidecar CLI itself.
 *
 * A package whose manifest declares no license is NOT waved through. The package directory is read
 * for a license file and the SPDX id derived from its text; a package with neither goes through
 * `throw`, which fails the run and therefore the release. That path is real rather than theoretical:
 * `khroma`, a transitive dependency of mermaid, ships the MIT text in a `license` file and declares
 * nothing in its manifest.
 *
 *   pnpm release:third-party                write THIRD-PARTY.md
 *   pnpm release:third-party --self-test    prove that an unlicensed component fails the run
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** One entry of `pnpm licenses list --json`, which groups its entries under the license id. */
interface PnpmLicenseEntry {
  readonly name: string
  readonly versions: readonly string[]
  readonly paths: readonly string[]
  readonly license: string
  readonly homepage?: string
}

type PnpmLicenseReport = Readonly<Record<string, readonly PnpmLicenseEntry[]>>

interface ShippedGraph {
  /** The package directory, relative to the repository root. */
  readonly directory: string
  /** What the graph is, for the reader of the notice. */
  readonly ships: string
}

interface ComponentRow {
  readonly name: string
  readonly version: string
  readonly license: string
  /** True when the id came from a license FILE because the manifest declared nothing. */
  readonly fromLicenseFile: boolean
  readonly graphs: readonly string[]
}

interface RuntimeRow {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly note: string
}

interface LicenseTextMarker {
  readonly id: string
  /** Every phrase must appear in the lowercased license text for the id to match. */
  readonly phrases: readonly string[]
  /** A phrase that must NOT appear, or null. Separates the BSD variants from each other. */
  readonly absent: string | null
}

interface SelfTestCase {
  readonly name: string
  readonly run: () => string | null
}

class GenerateThirdParty {
  private static readonly labelConst = '[release:third-party]'
  private static readonly repoRootConst = resolve(import.meta.dirname, '..', '..')
  private static readonly outputFileConst = 'THIRD-PARTY.md'

  /**
   * The graphs an installer actually carries. `app-client-cli` is deliberately absent: it has no
   * production dependency at all, and it is not packaged.
   */
  private static readonly shippedGraphsConst: readonly ShippedGraph[] = [
    { directory: 'app-client-ui', ships: 'the Electron client, packed into the installer' },
    { directory: 'app-host', ships: 'the detached Host, bundled into `resources/host`' },
    { directory: 'lib-orchestrator', ships: "the library bundled into the client's main process" },
  ]

  /**
   * pnpm says `Unknown` for a manifest with no `license` field, and npm's own convention has two
   * more ways of saying the same thing. All three send the package to the license-file reader.
   */
  private static readonly undeclaredLicensesConst: readonly string[] = [
    'unknown',
    'unlicensed',
    'see license in',
  ]

  /**
   * Enough of each license text to name it. Order matters: Apache and MPL carry their own titles,
   * ISC has no wording in common with MIT, and the two BSD variants differ only by the third clause.
   */
  private static readonly licenseTextMarkersConst: readonly LicenseTextMarker[] = [
    { id: 'Apache-2.0', phrases: ['apache license', 'version 2.0'], absent: null },
    { id: 'MPL-2.0', phrases: ['mozilla public license', 'version 2.0'], absent: null },
    { id: 'ISC', phrases: ['permission to use, copy, modify, and/or distribute'], absent: null },
    { id: 'MIT', phrases: ['permission is hereby granted, free of charge'], absent: null },
    {
      id: 'BSD-3-Clause',
      phrases: ['redistribution and use in source and binary forms', 'neither the name'],
      absent: null,
    },
    {
      id: 'BSD-2-Clause',
      phrases: ['redistribution and use in source and binary forms'],
      absent: 'neither the name',
    },
    {
      id: 'Unlicense',
      phrases: ['this is free and unencumbered software released into the public domain'],
      absent: null,
    },
  ]

  private static readonly licenseFileNameConst = /^(licen[cs]e|copying)(\.(md|txt))?$/i

  /**
   * Node.js publishes no manifest this repository can read - the sidecar downloads a signed archive
   * from nodejs.org - so its license is named here rather than derived. It has been MIT for the
   * whole 22.x line; the version beside it comes from the sidecar manifest.
   */
  private static readonly nodeRuntimeLicenseConst = 'MIT'

  static run(): void {
    if (process.argv.slice(2).includes('--self-test')) {
      GenerateThirdParty.selfTest()
      return
    }

    const components = GenerateThirdParty.components()
    const runtimes = GenerateThirdParty.runtimes()
    const document = GenerateThirdParty.render(components, runtimes)
    const output = join(GenerateThirdParty.repoRootConst, GenerateThirdParty.outputFileConst)
    writeFileSync(output, document, 'utf-8')

    const derived = components.filter((row) => row.fromLicenseFile).length
    console.log(
      `${GenerateThirdParty.labelConst} ${GenerateThirdParty.outputFileConst}: `
        + `${String(components.length)} components, ${String(runtimes.length)} runtimes, `
        + `${String(GenerateThirdParty.licenseCounts(components).size)} distinct licenses`,
    )
    if (derived > 0)
      console.log(
        `${GenerateThirdParty.labelConst} ${String(derived)} license(s) read from a license file `
          + 'because the manifest declared none',
      )
  }

  // -----------------------------------------------------------------------------------------------
  // components
  // -----------------------------------------------------------------------------------------------

  /** Every package of every shipped graph, deduplicated by name@version and sorted. */
  private static components(): readonly ComponentRow[] {
    const byKey = new Map<string, { row: ComponentRow; graphs: Set<string> }>()

    for (const graph of GenerateThirdParty.shippedGraphsConst) {
      const report = GenerateThirdParty.readGraph(graph.directory)
      for (const entries of Object.values(report))
        for (const entry of entries)
          for (const version of entry.versions) {
            const license = GenerateThirdParty.licenseOf(entry, version, graph.directory)
            const key = `${entry.name}@${version}`
            const existing = byKey.get(key)
            if (existing !== undefined) {
              existing.graphs.add(graph.directory)
              continue
            }
            byKey.set(key, {
              row: {
                name: entry.name,
                version,
                license: license.id,
                fromLicenseFile: license.fromLicenseFile,
                graphs: [],
              },
              graphs: new Set([graph.directory]),
            })
          }
    }

    return [...byKey.values()]
      .map(({ row, graphs }) => ({ ...row, graphs: [...graphs].sort() }))
      .sort((left, right) => GenerateThirdParty.compareComponents(left, right))
  }

  private static compareComponents(left: ComponentRow, right: ComponentRow): number {
    const byName = left.name.localeCompare(right.name, 'en')
    if (byName !== 0) return byName
    return left.version.localeCompare(right.version, 'en')
  }

  /** Runs pnpm in the package directory and parses its report. */
  private static readGraph(directory: string): PnpmLicenseReport {
    const cwd = join(GenerateThirdParty.repoRootConst, directory)
    if (!existsSync(join(cwd, 'node_modules')))
      throw new Error(
        `${directory} has no node_modules - run \`pnpm -C ${directory} install\` first, `
          + 'the notice is generated from the installed graph',
      )

    // One shell string rather than a command plus arguments: pnpm is a `.cmd` shim on Windows and
    // Node refuses to spawn one directly, and passing arguments alongside `shell: true` is
    // deprecated because the shell re-reads them. Nothing here comes from outside this file.
    const listed = spawnSync('pnpm licenses list --json --prod', {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    })
    if (listed.error !== undefined) throw listed.error
    if (listed.status !== 0)
      throw new Error(
        `pnpm licenses list failed in ${directory} (status ${String(listed.status)}): `
          + String(listed.stderr).trim(),
      )
    return JSON.parse(listed.stdout) as PnpmLicenseReport
  }

  /**
   * The declared license, or the one its license file carries. Review 150: a package with neither
   * fails the run rather than appearing in the notice with a blank.
   */
  private static licenseOf(
    entry: PnpmLicenseEntry,
    version: string,
    graph: string,
  ): { id: string; fromLicenseFile: boolean } {
    const declared = entry.license.trim()
    if (declared !== '' && !GenerateThirdParty.isUndeclared(declared))
      return { id: declared, fromLicenseFile: false }

    for (const path of entry.paths) {
      const derived = GenerateThirdParty.licenseFromFiles(path)
      if (derived !== null) return { id: derived, fromLicenseFile: true }
    }

    throw new Error(
      `no license for ${entry.name}@${version} in ${graph}: the manifest declares `
        + `"${entry.license}" and no license file in the package names one. Resolve the license `
        + 'before releasing - the notice must not ship an unattributed component.',
    )
  }

  private static isUndeclared(license: string): boolean {
    const lowered = license.toLowerCase()
    return GenerateThirdParty.undeclaredLicensesConst.some((marker) => lowered.startsWith(marker))
  }

  /** Reads the package directory's license file, if it has one, and names what it says. */
  private static licenseFromFiles(packageDirectory: string): string | null {
    if (!existsSync(packageDirectory)) return null
    const names = readdirSync(packageDirectory)
      .filter((name) => GenerateThirdParty.licenseFileNameConst.test(name))
      .sort()
    for (const name of names) {
      const identified = GenerateThirdParty.licenseFromText(
        readFileSync(join(packageDirectory, name), 'utf-8'),
      )
      if (identified !== null) return identified
    }
    return null
  }

  private static licenseFromText(text: string): string | null {
    const lowered = text.toLowerCase().replace(/\s+/g, ' ')
    for (const marker of GenerateThirdParty.licenseTextMarkersConst) {
      if (!marker.phrases.every((phrase) => lowered.includes(phrase))) continue
      if (marker.absent !== null && lowered.includes(marker.absent)) continue
      return marker.id
    }
    return null
  }

  // -----------------------------------------------------------------------------------------------
  // runtimes
  // -----------------------------------------------------------------------------------------------

  /** The three components that arrive as archives rather than through an npm graph. */
  private static runtimes(): readonly RuntimeRow[] {
    return [
      {
        name: 'Electron',
        version: GenerateThirdParty.electronVersion(),
        license: GenerateThirdParty.electronLicense(),
        note:
          'the application runtime the installer carries. Electron embeds Chromium '
          + '(BSD-3-Clause and the licenses named in its own credits), Node.js (MIT) and V8 '
          + '(BSD-3-Clause).',
      },
      {
        name: 'Node.js',
        version: GenerateThirdParty.sidecarNodeVersion(),
        license: GenerateThirdParty.nodeRuntimeLicenseConst,
        note:
          'the runtime the reMarkable sidecar runs on. The installer carries a sha256-pinned '
          + 'official build from nodejs.org, unmodified.',
      },
      {
        name: 'remarkable-cli',
        version: GenerateThirdParty.sidecarCliVersion(),
        license: GenerateThirdParty.sidecarCliLicense(),
        note:
          'the reMarkable command line tool the sidecar invokes. Its own dependency tree is '
          + 'installed beside it at seed time and pinned in `configs/remarkable-sidecar/'
          + 'package-lock.json`, which names each of those licenses.',
      },
    ]
  }

  private static electronVersion(): string {
    const manifest = GenerateThirdParty.readJson<{
      devDependencies?: Record<string, string>
    }>(join('app-client-ui', 'package.json'))
    const version = manifest.devDependencies?.['electron']
    if (version === undefined) throw new Error('app-client-ui declares no electron dependency')
    return version
  }

  private static electronLicense(): string {
    const manifest = GenerateThirdParty.readJson<{ license?: string }>(
      join('app-client-ui', 'node_modules', 'electron', 'package.json'),
    )
    if (manifest.license === undefined) throw new Error('the installed electron declares no license')
    return manifest.license
  }

  /** Every platform recipe pins the same Node build; a split would make the notice ambiguous. */
  private static sidecarNodeVersion(): string {
    const manifest = GenerateThirdParty.readJson<{
      platforms: Record<string, { node: { version: string } }>
    }>(join('configs', 'remarkable-sidecar', 'manifest.json'))
    const versions = [
      ...new Set(Object.values(manifest.platforms).map((platform) => platform.node.version)),
    ].sort()
    if (versions.length !== 1)
      throw new Error(`the sidecar recipes pin more than one Node build: ${versions.join(', ')}`)
    return versions[0] as string
  }

  private static sidecarCliVersion(): string {
    const manifest = GenerateThirdParty.readJson<{ cli: { version: string } }>(
      join('configs', 'remarkable-sidecar', 'manifest.json'),
    )
    return manifest.cli.version
  }

  private static sidecarCliLicense(): string {
    const manifest = GenerateThirdParty.readJson<{ cli: { package: string } }>(
      join('configs', 'remarkable-sidecar', 'manifest.json'),
    )
    const lock = GenerateThirdParty.readJson<{
      packages: Record<string, { license?: string }>
    }>(join('configs', 'remarkable-sidecar', 'package-lock.json'))
    const entry = lock.packages[`node_modules/${manifest.cli.package}`]
    if (entry?.license === undefined)
      throw new Error(`the sidecar lockfile names no license for ${manifest.cli.package}`)
    return entry.license
  }

  private static readJson<T>(relativePath: string): T {
    const absolute = join(GenerateThirdParty.repoRootConst, relativePath)
    return JSON.parse(readFileSync(absolute, 'utf-8')) as T
  }

  // -----------------------------------------------------------------------------------------------
  // rendering
  // -----------------------------------------------------------------------------------------------

  private static licenseCounts(components: readonly ComponentRow[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const row of components) counts.set(row.license, (counts.get(row.license) ?? 0) + 1)
    return counts
  }

  private static render(
    components: readonly ComponentRow[],
    runtimes: readonly RuntimeRow[],
  ): string {
    const lines: string[] = []
    lines.push('# Third-Party Licenses')
    lines.push('')
    lines.push(
      'Jamat is [MIT licensed](LICENSE) and builds on the work below. This file is **generated** by',
    )
    lines.push(
      '`pnpm release:third-party` from the installed production dependency graphs; the release script',
    )
    lines.push('regenerates it and refuses to release when the committed copy is out of date. Edit')
    lines.push('`scripts/release/generate-third-party.ts`, never this file.')
    lines.push('')
    lines.push('The graphs it reads are the ones an installer carries:')
    lines.push('')
    for (const graph of GenerateThirdParty.shippedGraphsConst)
      lines.push(`- \`${graph.directory}\` - ${graph.ships}`)
    lines.push('')
    lines.push(
      'A component whose manifest declares no license is read out of the license file shipped in the',
    )
    lines.push(
      'package, and one that has neither fails the generator, so nothing reaches this list unattributed.',
    )
    lines.push('')

    lines.push('## Runtimes')
    lines.push('')
    lines.push('| Component | Version | License | What it is |')
    lines.push('| --- | --- | --- | --- |')
    for (const runtime of runtimes)
      lines.push(
        `| ${runtime.name} | ${runtime.version} | ${runtime.license} | ${runtime.note} |`,
      )
    lines.push('')

    lines.push('## Licenses in use')
    lines.push('')
    lines.push(`${String(components.length)} npm components across the three graphs.`)
    lines.push('')
    lines.push('| License | Components |')
    lines.push('| --- | --- |')
    const counts = [...GenerateThirdParty.licenseCounts(components).entries()].sort(
      (left, right) => left[0].localeCompare(right[0], 'en'),
    )
    for (const [license, count] of counts) lines.push(`| ${license} | ${String(count)} |`)
    lines.push('')

    lines.push('## Components')
    lines.push('')
    lines.push(
      'The `Graphs` column names which shipped graph pulls the component in. A `*` on the license'
        + ' means',
    )
    lines.push("the package declares none in its manifest and the id was read from its license file.")
    lines.push('')
    lines.push('| Component | Version | License | Graphs |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of components)
      lines.push(
        `| \`${row.name}\` | ${row.version} | ${row.license}${row.fromLicenseFile ? ' \\*' : ''} `
          + `| ${row.graphs.join(', ')} |`,
      )
    lines.push('')
    return lines.join('\n')
  }

  // -----------------------------------------------------------------------------------------------
  // self test
  // -----------------------------------------------------------------------------------------------

  /**
   * The one property worth proving: a component with no license anywhere stops the release. The
   * rest of the generator is proven by running it, which `release.sh` does on every release.
   */
  private static selfTest(): void {
    const cases: readonly SelfTestCase[] = [
      {
        name: 'a package declaring no license and shipping none fails the run',
        run: () => {
          const directory = GenerateThirdParty.fixtureDirectory({})
          try {
            GenerateThirdParty.licenseOf(
              { name: 'ghost', versions: ['1.0.0'], paths: [directory], license: 'Unknown' },
              '1.0.0',
              'fixture',
            )
            return 'expected a throw, got a license'
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            return text.includes('no license for ghost@1.0.0') ? null : `wrong message: ${text}`
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
        },
      },
      {
        name: 'a declared license is taken from the manifest',
        run: () => {
          const resolved = GenerateThirdParty.licenseOf(
            { name: 'declared', versions: ['2.0.0'], paths: [], license: 'BSD-3-Clause' },
            '2.0.0',
            'fixture',
          )
          if (resolved.id !== 'BSD-3-Clause') return `got ${resolved.id}`
          return resolved.fromLicenseFile ? 'marked as read from a file' : null
        },
      },
      {
        name: 'an undeclared license is read from the license file',
        run: () => {
          const directory = GenerateThirdParty.fixtureDirectory({
            license:
              'The MIT License (MIT)\n\nPermission is hereby granted, free of charge, to any '
              + 'person obtaining a copy of this software.',
          })
          try {
            const resolved = GenerateThirdParty.licenseOf(
              { name: 'filed', versions: ['3.0.0'], paths: [directory], license: 'Unknown' },
              '3.0.0',
              'fixture',
            )
            if (resolved.id !== 'MIT') return `got ${resolved.id}`
            return resolved.fromLicenseFile ? null : 'not marked as read from a file'
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
        },
      },
      {
        name: 'a license file naming nothing recognisable still fails the run',
        run: () => {
          const directory = GenerateThirdParty.fixtureDirectory({
            'LICENSE.txt': 'You may use this if you send the author a postcard.',
          })
          try {
            GenerateThirdParty.licenseOf(
              { name: 'postcard', versions: ['1.0.0'], paths: [directory], license: '' },
              '1.0.0',
              'fixture',
            )
            return 'expected a throw, got a license'
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            return text.includes('no license for postcard@1.0.0') ? null : `wrong message: ${text}`
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
        },
      },
      {
        name: 'the BSD variants are told apart by the third clause',
        run: () => {
          const three = GenerateThirdParty.licenseFromText(
            'Redistribution and use in source and binary forms, with or without modification, are '
              + 'permitted. Neither the name of the copyright holder nor the names of its '
              + 'contributors may be used to endorse products.',
          )
          const two = GenerateThirdParty.licenseFromText(
            'Redistribution and use in source and binary forms, with or without modification, are '
              + 'permitted provided that the following conditions are met.',
          )
          if (three !== 'BSD-3-Clause') return `three-clause read as ${String(three)}`
          return two === 'BSD-2-Clause' ? null : `two-clause read as ${String(two)}`
        },
      },
    ]

    const failures: string[] = []
    for (const testCase of cases) {
      const failure = testCase.run()
      console.log(`${failure === null ? '  ok  ' : '  RED '} ${testCase.name}`)
      if (failure !== null) failures.push(`${testCase.name}: ${failure}`)
    }

    if (failures.length === 0) {
      console.log(`\n${GenerateThirdParty.labelConst} self-test GREEN`)
      return
    }
    console.error(`\n${GenerateThirdParty.labelConst} self-test RED:`)
    for (const failure of failures) console.error(`   - ${failure}`)
    process.exitCode = 1
  }

  /** A throwaway package directory holding the given files. */
  private static fixtureDirectory(files: Readonly<Record<string, string>>): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-third-party-'))
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(directory, name), content, 'utf-8')
    return directory
  }
}

GenerateThirdParty.run()
