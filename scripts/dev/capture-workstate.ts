/**
 * Diagnostic, not a gate. It reads every live Host on this machine, builds each alive session's
 * frame exactly the way the work-state monitor does, prints what both inspectors make of it, and
 * writes the frames out as CANDIDATES for the fixture corpus.
 *
 * It exists because the corpus was inherited rather than recorded. Every fixture under
 * `lib-orchestrator/sessionManager/workState/fixtures/` was copied from AppJamat V1 as a single line
 * of sanitized text, so the suite could stay green while the real TUI drifted underneath it: the
 * selection glyph changed, and a repaint writes `ESC[1C` where a person sees a space. A pattern is
 * evidence about somebody else's terminal, and this is how that evidence is collected.
 *
 *   pnpm dev:capture-workstate                 # candidates into a fresh temp directory
 *   pnpm dev:capture-workstate -- <outDir>     # candidates into <outDir>
 *
 * It is in scripts/dev/ rather than scripts/smoke/ for the same reason `probe-agent.ts` is: it needs
 * live authenticated agents parked on the screens of interest, so it can never be a deterministic
 * gate.
 *
 * READ-ONLY toward every Host: `runtime.list` and `runtime.inspect`, nothing else. It takes no
 * controller lease, calls no mutation op and writes to no terminal, so it is safe to run against the
 * Host a person is working in. It also never writes into `fixtures/`: admission is a hand step
 * (sanitize, then add `expected`, `provenance` and `recorded`), and an output directory inside the
 * corpus is refused before any Host is touched.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  HostDescriptor,
  RuntimeInspectResult,
  RuntimeListResult,
} from '../../app-host/app/wire/hostWire.js'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths.js'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare.js'
import { AgentWorkInspectorClaude } from '../../lib-orchestrator/sessionManager/workState/agentWorkInspectorClaude.js'
import { AgentWorkInspectorCodex } from '../../lib-orchestrator/sessionManager/workState/agentWorkInspectorCodex.js'
import { ScreenTail } from '../../lib-orchestrator/sessionManager/workState/screenTail.js'
import type { AgentWorkInspection } from '../../lib-orchestrator/sessionManager/workState/agentWorkInspector.types.js'

/** One descriptor found on this machine, with the two names that say which Host it belongs to. */
interface FoundHost {
  configIdentity: string
  channel: string
  descriptor: HostDescriptor
}

class CaptureWorkstate {
  /**
   * Anchored to the repository rather than to `process.cwd()`. Relative, it resolved against
   * wherever the script was started, so running it from inside a package pointed the guard at a
   * path that does not exist - and the corpus it exists to protect was writable after all.
   */
  private static readonly fixturesDirConst = join(
    fileURLToPath(new URL('../../', import.meta.url)),
    'lib-orchestrator', 'sessionManager', 'workState', 'fixtures',
  )
  private static readonly descriptorFileNameConst = 'descriptor.json'
  private static written = 0

  static async run(): Promise<void> {
    const outDir = CaptureWorkstate.outputDirectory(process.argv[2])
    const hosts = CaptureWorkstate.hosts()
    if (hosts.length === 0) console.log('no Host descriptor on this machine')
    for (const host of hosts) await CaptureWorkstate.captureHost(host, outDir)
    console.log(`\n${CaptureWorkstate.written} candidate frames written to ${outDir}`)
  }

  /**
   * The corpus is refused as a destination before anything else happens. A candidate is not a
   * fixture: it carries no verdict, no provenance, and the user's own paths and prompts, and the
   * whole admission step exists to make somebody look at it first.
   */
  private static outputDirectory(argument: string | undefined): string {
    if (argument === undefined) return mkdtempSync(join(tmpdir(), 'jamat-v3-workstate-'))
    const chosen = resolve(argument)
    // `PathCompare.isInside` rather than a string prefix: it knows that a sibling whose name
    // merely begins the same is not inside, and which platform compares case-insensitively.
    if (PathCompare.isInside(resolve(CaptureWorkstate.fixturesDirConst), chosen))
      throw new Error(`refusing to write candidates into the fixture corpus: ${chosen}`)
    if (!existsSync(chosen)) throw new Error(`no such directory: ${chosen}`)
    return chosen
  }

  /** Every identity and every channel, because the point is to find the Host a person is using. */
  private static hosts(): FoundHost[] {
    const root = HostDescriptorPaths.scopeRoot()
    if (!existsSync(root)) return []
    const found: FoundHost[] = []
    for (const configIdentity of readdirSync(root)) {
      const identityDirectory = join(root, configIdentity)
      if (!statSync(identityDirectory).isDirectory()) continue
      for (const channel of readdirSync(identityDirectory)) {
        const file = join(identityDirectory, channel, CaptureWorkstate.descriptorFileNameConst)
        if (!existsSync(file)) continue
        found.push({
          configIdentity,
          channel,
          descriptor: JSON.parse(readFileSync(file, 'utf8')) as HostDescriptor,
        })
      }
    }
    return found
  }

  /**
   * A Host that does not answer is one printed line and the next Host: a descriptor outlives the
   * process that wrote it, so a stale one is the normal case, not a failure of this run.
   */
  private static async captureHost(host: FoundHost, outDir: string): Promise<void> {
    const label = `${host.configIdentity}/${host.channel}`
    let listing: RuntimeListResult
    try {
      listing = await CaptureWorkstate.op<RuntimeListResult>(host.descriptor, 'runtime.list', {})
    } catch (error) {
      console.log(`\n== ${label}: unreachable (${CaptureWorkstate.messageOf(error)})`)
      return
    }
    const alive = listing.sessions.filter((session) => session.alive)
    console.log(`\n== ${label} port ${host.descriptor.port}: ${alive.length} alive`)
    for (const session of alive) {
      const inspected = await CaptureWorkstate.op<RuntimeInspectResult>(
        host.descriptor,
        'runtime.inspect',
        {
          target: {
            hostInstanceId: listing.hostInstanceId,
            runtimeSessionId: session.runtimeSessionId,
            generation: session.generation,
          },
        },
      )
      if (inspected.projection === null) {
        console.log(`   ${session.runtimeSessionId}: no projection`)
        continue
      }
      const frame = ScreenTail.frameOf(inspected.projection)
      // Both inspectors are run because the Host is agent-agnostic: nothing in a listing says which
      // agent a runtime is, and the record that would is the session manager's, not this tool's.
      const verdicts = {
        claude: AgentWorkInspectorClaude.inspect(frame),
        codex: AgentWorkInspectorCodex.inspect(frame),
      }
      const age = session.lastOutputAt === null
        ? 'never'
        : `${Math.round((Date.now() - session.lastOutputAt) / 1_000)}s`
      console.log(`   ${session.runtimeSessionId}: claude=${verdicts.claude.hint} `
        + `codex=${verdicts.codex.hint} lastOutput=${age}`)
      console.log(`     ${CaptureWorkstate.signalsOf(verdicts.claude, verdicts.codex)}`)
      writeFileSync(
        join(outDir, `frame-${session.runtimeSessionId}.json`),
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          configIdentity: host.configIdentity,
          channel: host.channel,
          session,
          verdicts,
          frame,
        }, null, 2),
      )
      CaptureWorkstate.written += 1
    }
  }

  private static signalsOf(claude: AgentWorkInspection, codex: AgentWorkInspection): string {
    const named = [...claude.evidence, ...codex.evidence]
      .map((item) => `${item.source}:${item.signal}`)
    return named.length === 0 ? 'no evidence' : named.join(' ')
  }

  private static async op<T>(
    descriptor: HostDescriptor,
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/op/${name}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${name} answered ${response.status}: ${text}`)
    return JSON.parse(text) as T
  }

  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

void CaptureWorkstate.run().catch((error: unknown) => {
  console.error(`capture-workstate: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
