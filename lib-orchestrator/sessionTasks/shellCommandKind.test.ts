import { describe, expect, it } from 'vitest'

import { ShellCommandKind } from './shellCommandKind'

describe('lib-orchestrator/sessionTasks/shellCommandKind', () => {
  it.each([
    'codex exec "fix it"',
    'claude -p x',
    'agy -p x',
    'gemini -p x',
    'node "C:/x/agy-run.mjs" --json',
    'node C:\\x\\codex-run.mjs --json',
    'node /opt/tools/claude-run.mjs',
    'cd app && codex.exe exec y',
    'npx claude -p x',
    'npx -y claude -p x',
    'pnpm exec codex exec y',
    'pnpm dlx claude -p x',
    'cmd /c codex exec y',
    'cmd.exe /C "cd app && codex exec y"',
    'bash -c "claude -p hi"',
    'sh -c "cd dir && agy -p hi"',
    'pwsh -Command "codex exec x"',
    'powershell -NoProfile -Command "claude -p x"',
    'FOO=1 claude -p x',
    'env FOO=1 BAR=2 codex exec hi',
    'echo setup\ncodex exec "second line"',
    `${'echo ' + 'a'.repeat(170)} && claude -p after-160`,
  ])('classifies agent command as agent: %s', (command) => {
    expect(ShellCommandKind.of(command)).toBe('agent')
  })

  it.each([
    '',
    'cat CLAUDE.md',
    'grep agy src',
    'cd /work/codex && pnpm test',
    'node scripts/codex-check.mjs',
    'node q:/jamat/app-client-cli/start.ts sessions list',
    'echo codex',
    'echo "a && codex exec x"',
    'bash -c "echo claude"',
    'pwsh -Command "pnpm test"',
    'pnpm test',
  ])('classifies ordinary command as command: %s', (command) => {
    expect(ShellCommandKind.of(command)).toBe('command')
  })
})
