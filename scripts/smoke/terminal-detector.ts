import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { PathExtractors } from '../../lib-orchestrator/terminalDetector/extract/pathExtractors.js'
import { TerminalDetector } from '../../lib-orchestrator/terminalDetector/terminalDetector.js'
import { TerminalDetectorLimits } from '../../lib-orchestrator/terminalDetector/terminalDetectorLimits.js'
import type {
  TerminalDetection,
  TerminalDetectorAgentId,
} from '../../lib-orchestrator/terminalDetector/terminalDetectorApi.types.js'
import type { ChangedPathHint } from '../../lib-orchestrator/terminalDetector/terminalDetectorApi.types.js'

class SmokeTerminalDetector extends SmokeHarness {
  private readonly workspace: string
  private readonly elsewhere: string
  private readonly sessionId = 'terminal-detector-smoke-session'
  private clock = 1_000

  private constructor(root: string) {
    super()
    this.workspace = join(root, 'workspace')
    this.elsewhere = join(root, 'elsewhere')
  }

  static async run(): Promise<void> {
    const temporary = mkdtempSync(join(tmpdir(), 'jamat-v3-terminal-detector-smoke-'))
    const root = realpathSync.native(temporary)
    try { await new SmokeTerminalDetector(root).execute() }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }

  private async execute(): Promise<void> {
    this.seed()

    const plan = join(this.workspace, '.aidocs', 'plans', '2026-07-10-001-refactor-plan.md')
    await this.detects('an absolute path names its own file',
      join(this.workspace, 'src', 'deep', 'report.md'),
      (detection) => detection.kind === 'file' && detection.path === join(this.workspace, 'src', 'deep', 'report.md'))
    await this.detects('a slash-prefixed Windows Markdown link path names its own file',
      `/${join(this.workspace, 'src', 'deep', 'report.md').replace(/\\/g, '/')}`,
      (detection) => detection.kind === 'file' && detection.path === join(this.workspace, 'src', 'deep', 'report.md'),
      'codex')
    await this.detects('a pdf is detected as a file the desktop opens rather than the viewer',
      join(this.workspace, 'docs', 'manual.pdf'),
      (detection) => detection.kind === 'file' && detection.opensExternally)
    await this.detects('a file the viewer can read keeps the viewer',
      join(this.workspace, 'src', 'deep', 'report.md'),
      (detection) => detection.kind === 'file' && !detection.opensExternally)
    await this.detects('a path relative to the session resolves under its working directory',
      'src/deep/report.md',
      (detection) => detection.kind === 'file' && detection.path === join(this.workspace, 'src', 'deep', 'report.md'))
    await this.detects('a :line:col reference is split off and carried',
      `${join(this.workspace, 'src', 'deep', 'report.md')}:42:7`,
      (detection) => detection.kind === 'file' && detection.line === 42 && detection.column === 7)
    await this.detects('a reference ending a sentence still resolves',
      'src/deep/report.md:2188.',
      (detection) => detection.kind === 'file' && detection.line === 2188)
    await this.detects('a quoted path keeps the spaces inside it',
      `"${join(this.workspace, 'a name with spaces.md')}"`,
      (detection) => detection.kind === 'file' && detection.path.endsWith('a name with spaces.md'))
    await this.detects('a file:// URI becomes a native path and its escapes are decoded',
      `file:///${join(this.workspace, 'a name with spaces.md').replace(/\\/g, '/').replace(/ /g, '%20')}`,
      (detection) => detection.kind === 'file' && detection.path.endsWith('a name with spaces.md'))
    await this.detects('a truncated Claude name resolves through a walk of the project',
      '2026-07-10-001-…-plan.md',
      (detection) => detection.kind === 'file' && detection.path === plan, 'claude')
    await this.detects('a directory is detected as one and lists its files',
      join(this.workspace, 'src', 'deep'),
      (detection) => detection.kind === 'directory'
        && detection.children.map((child) => child.name).join() === 'report.md')
    await this.detects('a URL beside the token is offered too',
      'src/deep/report.md',
      (detection) => detection.kind === 'url' && detection.url === 'https://example.com/why',
      null, 'wrote src/deep/report.md, see https://example.com/why for the reason', 2)

    this.codexRewrite()
    await this.changeLogBeatsTheWalk()
    await this.expiry()
    this.register()

    console.log(`\nsmoke-terminal-detector: ${this.passed} checks passed`)
  }

  private codexRewrite(): void {
    // Asserted on the extractor rather than end to end: the rewrite targets the real home directory,
    // and a smoke may not seed a file inside the user's own `.codex` store to reach it.
    const token = '\\Users\\someone\\.codex\\sessions\\2026\\04\\24\\rollout-x.jsonl'
    const expected = join(homedir(), '.codex', 'sessions', '2026', '04', '24', 'rollout-x.jsonl')
    const candidates = PathExtractors.of('codex').resolve(token, { projectDir: this.workspace })
    const base = PathExtractors.of(null).resolve(token, { projectDir: this.workspace })
    this.check('a driveless Codex session path is rewritten under the home directory',
      candidates.length === 1 && candidates[0].kind === 'direct' && candidates[0].path === expected)
    this.check('and no other agent rewrites it',
      base.some((candidate) => candidate.kind === 'direct' && candidate.path === token))
  }

  private async changeLogBeatsTheWalk(): Promise<void> {
    const changed = join(this.elsewhere, 'moved', 'report.md')
    const detector = this.detector(null, [{ path: changed }])
    const result = await detector.detect(this.sessionId,
      { token: 'cut\\report.md', selection: null, contextText: 'cut\\report.md', fallbackToken: null })
    this.check('the change log answers a partial path before the project is walked',
      result.detections.length === 1
      && result.detections[0].kind === 'file'
      && result.detections[0].path === changed)
  }

  private async expiry(): Promise<void> {
    const detector = this.detector()
    const result = await detector.detect(this.sessionId,
      { token: 'src/deep/report.md', selection: null, contextText: '', fallbackToken: null })
    const detectionId = result.detections[0].detectionId
    this.check('a fresh detection id resolves to its path',
      detector.pathOf(result.requestId, detectionId) !== null)
    this.check('an id from nowhere resolves to nothing',
      detector.pathOf(result.requestId, 'made-up') === null)
    this.clock += TerminalDetectorLimits.requestTtlMilliseconds + 1
    this.check('an expired request resolves to nothing',
      detector.pathOf(result.requestId, detectionId) === null)
  }

  private register(): void {
    const detector = this.detector()
    detector.markOpened(join(this.workspace, 'src'), 'directory')
    this.check('a file inside an opened directory counts as proven',
      detector.wasOpened(join(this.workspace, 'src', 'deep', 'report.md')))
    this.check('a file outside every opened path does not',
      !detector.wasOpened(join(this.elsewhere, 'moved', 'report.md')))
  }

  private detector(
    agentId: TerminalDetectorAgentId | null = null,
    hints: readonly ChangedPathHint[] = [],
  ): TerminalDetector {
    return new TerminalDetector({
      workingContext: (sessionId) => Promise.resolve({
        ok: true,
        value: {
          sessionId,
          cwd: this.workspace,
          agent: agentId === null ? null : { agentId, nativeSessionId: 'native' },
          worktree: null,
        },
      }),
      changedPaths: () => Promise.resolve(hints),
    }, () => this.clock)
  }

  private async detects(
    description: string,
    token: string,
    holds: (detection: TerminalDetection) => boolean,
    agentId: TerminalDetectorAgentId | null = null,
    contextText = token,
    expected = 1,
  ): Promise<void> {
    const result = await this.detector(agentId)
      .detect(this.sessionId, { token, selection: null, contextText, fallbackToken: null })
    // The count matters as much as the hit: an extra wrong detection is a wrong row in the menu.
    this.check(description, result.detections.length === expected && result.detections.some(holds))
  }

  private seed(): void {
    for (const path of [
      join(this.workspace, 'src', 'deep'),
      join(this.workspace, '.aidocs', 'plans'),
      join(this.workspace, 'docs'),
      join(this.elsewhere, 'moved'),
    ]) mkdirSync(path, { recursive: true })
    writeFileSync(join(this.workspace, 'src', 'deep', 'report.md'), '# Report\n')
    writeFileSync(join(this.workspace, 'a name with spaces.md'), '# Spaces\n')
    writeFileSync(join(this.workspace, 'docs', 'manual.pdf'), '%PDF-1.4\n')
    writeFileSync(join(this.workspace, '.aidocs', 'plans', '2026-07-10-001-refactor-plan.md'), '# Plan\n')
    writeFileSync(join(this.elsewhere, 'moved', 'report.md'), '# Moved\n')
  }

}

void SmokeTerminalDetector.run().catch((error: unknown) => SmokeRun.failed('smoke-terminal-detector', error))
