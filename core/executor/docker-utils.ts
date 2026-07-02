import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DOCKER_IMAGE = 'jamat-isolated'

export function ensureDockerImage(dockerContextDir: string): void {
  const check = spawnSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' })
  if (check.status !== 0) {
    console.log('Building Docker image (first time)...')
    spawnSync('docker', ['build', '-t', DOCKER_IMAGE, dockerContextDir], { stdio: 'inherit' })
  }
}

export function buildDockerRunArgs(projectDir: string, dockerContextDir: string): string[] {
  const dockerHome = '/home/claude'
  const hostSshDir = join(homedir(), '.ssh')
  const hostClaudeDir = join(homedir(), '.claude')

  const claudeHome = join(projectDir, '.claude-home')
  if (!existsSync(claudeHome)) mkdirSync(claudeHome, { recursive: true })

  const targetConfig = join(claudeHome, '.claude.json')
  const hostConfig = join(homedir(), '.claude.json')
  if (!existsSync(targetConfig) && existsSync(hostConfig)) {
    copyFileSync(hostConfig, targetConfig)
  }

  return [
    '-v', `${claudeHome}:${dockerHome}/.claude`,
    '-v', `${projectDir}:/workspace`,
    '-v', `${hostClaudeDir}:/host-claude:ro`,
    '-v', `${hostSshDir}:/host-ssh:ro`,
  ]
}

export function syncDockerCredentials(projectDir: string): { synced: boolean; message: string } {
  const hostClaudeDir = join(homedir(), '.claude')
  const claudeHome = join(projectDir, '.claude-home')
  if (!existsSync(claudeHome)) mkdirSync(claudeHome, { recursive: true })

  const credsFile = join(hostClaudeDir, '.credentials.json')
  if (!existsSync(credsFile)) {
    return { synced: false, message: `No credentials found at ${credsFile}. Run 'claude auth login' on the host first.` }
  }

  copyFileSync(credsFile, join(claudeHome, '.credentials.json'))
  return { synced: true, message: `Credentials synced to ${claudeHome}` }
}
