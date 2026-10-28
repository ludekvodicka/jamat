import type { ProfileShareTable } from '../profiles/profileShareTable'

export const codexShareTable: ProfileShareTable = {
  directories: ['sessions', 'skills', 'hooks', 'rules', 'plugins', 'memories', 'generated', 'vendor_imports', 'rollout-migrations'],
  files: ['config.toml', 'AGENTS.md', 'hooks.json', 'history.jsonl', 'session_index.jsonl'],
  neverShared: ['auth.json', 'app-server-control', 'app-server-daemon', '.tmp', 'tmp', 'thread-writer-locks', 'log',
    '.sandbox', '.sandbox-bin', '.sandbox-secrets', 'cap_sid', 'mcp-oauth-locks', 'cache', 'packages', 'models_cache.json',
    'installation_id', '.codex-global-state.json'],
}

export function codexProfileEnvironment(mainHome: string): Record<string, string> {
  return { CODEX_SQLITE_HOME: mainHome }
}
