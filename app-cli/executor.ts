import { spawnSync } from 'child_process'
import { readFileSync, unlinkSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import type { MenuSelection } from '../core/types.js'
import { SESSION_ID_RE } from '../core/types.js'
import { ensureConfig, firstRunConfigMessage } from '../core/config.js'
import { resolveConfigDir } from '../core/config-dir.js'
import { buildLaunchCommand } from '../core/executor/agent-launcher.js'
import { getAgent } from '../core/agents/index.js'
import { ensureDockerImage, syncDockerCredentials, buildDockerRunArgs } from '../core/executor/docker-utils.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = resolve(SCRIPT_DIR, '..')

const args = process.argv.slice(2)
const argOf = (flag: string): string | null => {
  const i = args.indexOf(flag)
  if (i < 0) return null
  if (i + 1 >= args.length) { console.error(`Usage: executor.ts ${flag} <value>`); process.exit(1) }
  return args[i + 1]
}
const explicitConfig = argOf('--config')                                      // explicit config FILE
const explicitConfigDir = argOf('--config-dir') ?? process.env['JAMAT_CONFIG_DIR'] ?? null
// The portable config-dir (default ~/.jamat). CLI is build-agnostic → no -debug split. Passed to the
// menu-tui spawn (--config-dir) + the data writers so they share the SAME dir as electron.
const CONFIG_DIR = resolveConfigDir({ explicit: explicitConfigDir })

// An explicit --config FILE must exist (fail fast on a typo). Otherwise default to
// <config-dir>/config.json, first-run-creating a starter so a fresh clone runs without manual setup.
let configPath: string
try {
  if (explicitConfig) {
    const abs = resolve(explicitConfig)
    if (!existsSync(abs)) {
      console.error(`Config file not found: ${abs}`)
      process.exit(1)
    }
    configPath = abs
  } else {
    const r = ensureConfig(join(CONFIG_DIR, 'config.json'), join(MONOREPO_ROOT, 'configs', 'config.example.json'))
    configPath = r.path
    if (r.created) console.log('\n' + firstRunConfigMessage(configPath) + '\n')
  }
} catch (e) {
  console.error('[config] First-run setup failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}

const DOCKER_CONTEXT_DIR = join(MONOREPO_ROOT, 'dockerized-claude')

const SELECTION_FILE = join(tmpdir(), `jamat-menu-selection-${process.pid}.json`)

function readSelection(): MenuSelection | null {
  if (!existsSync(SELECTION_FILE)) return null
  try {
    const raw = readFileSync(SELECTION_FILE, 'utf-8')
    unlinkSync(SELECTION_FILE)
    const sel = JSON.parse(raw) as MenuSelection
    if (sel.sessionId && !SESSION_ID_RE.test(sel.sessionId)) {
      console.error('Invalid sessionId format')
      return null
    }
    return sel
  } catch {
    return null
  }
}

function setTerminalTitle(title: string) {
  process.stdout.write(`\x1b]0;${title}\x07`)
}

function pressAnyKey() {
  console.log('\nPress any key to return to menu...')
  spawnSync('node', ['-e', 'process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once("data",()=>process.exit())'],
    { stdio: 'inherit' })
}

function handleAction(sel: MenuSelection): void {
  switch (sel.action) {
    case 'docker-auth': {
      const result = syncDockerCredentials(sel.dir || process.cwd())
      console.log(`\n${result.message}`)
      pressAnyKey()
      break
    }
    case 'docker-shell': {
      ensureDockerImage(DOCKER_CONTEXT_DIR)
      const shellDir = sel.dir || process.cwd()
      const vols = buildDockerRunArgs(shellDir, DOCKER_CONTEXT_DIR)
      console.log(`\nOpening Docker shell in ${shellDir}...\n`)
      spawnSync('docker', ['run', '-it', '--rm', ...vols, 'jamat-isolated', 'bash'],
        { stdio: 'inherit' })
      pressAnyKey()
      break
    }
    case 'docker-rebuild': {
      console.log('\nRemoving old image...')
      spawnSync('docker', ['rmi', 'jamat-isolated'], { stdio: 'pipe' })
      console.log('Building Docker image...')
      const r = spawnSync('docker', ['build', '-t', 'jamat-isolated', DOCKER_CONTEXT_DIR], { stdio: 'inherit' })
      console.log(r.status === 0 ? '\nDocker image rebuilt successfully.' : '\nFailed to rebuild Docker image.')
      pressAnyKey()
      break
    }
    case 'custom-run': {
      const run = sel.run
      if (run) {
        const cwd = run.cwd || sel.dir || process.cwd()
        console.log(`\nRunning ${run.command} ${(run.args ?? []).join(' ')} in ${cwd}...\n`)
        spawnSync(run.command, run.args ?? [], { stdio: 'inherit', cwd, shell: true })
        if (run.pause !== false) pressAnyKey()
      }
      break
    }
  }
}

function launchAgent(sel: MenuSelection): void {
  const prefix = sel.isolated ? '[Docker] ' : ''
  setTerminalTitle(`${prefix}${sel.folderName} - ${getAgent(sel.agent).displayName}`)

  if (sel.isolated) {
    ensureDockerImage(DOCKER_CONTEXT_DIR)
  }

  const cmd = buildLaunchCommand({
    selection: sel,
    mode: 'terminal',
    dockerContextDir: DOCKER_CONTEXT_DIR,
  })

  const env = { ...process.env, ...cmd.env }

  const result = spawnSync(cmd.command, cmd.args, { stdio: 'inherit', cwd: cmd.cwd, env, shell: true })

  if (result.status !== 0 && cmd.fallback) {
    const fbEnv = { ...process.env, ...cmd.fallback.env }
    spawnSync(cmd.fallback.command, cmd.fallback.args, { stdio: 'inherit', cwd: cmd.fallback.cwd, env: fbEnv, shell: true })
  }
}


// --- Main loop ---
while (true) {
  if (existsSync(SELECTION_FILE)) unlinkSync(SELECTION_FILE)

  const menuTui = join(SCRIPT_DIR, 'menu-tui.ts')
  spawnSync('node', ['--import', 'tsx', menuTui, '--config', configPath, '--config-dir', CONFIG_DIR],
    { stdio: 'inherit', cwd: SCRIPT_DIR, env: { ...process.env, JAMAT_MENU_SELECTION_FILE: SELECTION_FILE } })

  const sel = readSelection()
  if (!sel) break

  if (sel.action) {
    handleAction(sel)
    continue
  }

  launchAgent(sel)
}
