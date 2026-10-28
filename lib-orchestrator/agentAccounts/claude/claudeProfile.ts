import type { ProfileShareTable } from '../profiles/profileShareTable'

export const claudeShareTable: ProfileShareTable = {
  directories: [
    'projects', 'skills', 'commands', 'plugins', 'plans', 'file-history', 'session-env',
    'paste-cache', 'tasks', 'scripts', 'docs', 'instructions', 'skills-archived', 'todos',
  ],
  files: ['settings.json', 'CLAUDE.md', 'history.jsonl', 'project-skill-installs.json', 'gitea.config.json', 'svntea.config.json'],
  neverShared: [
    '.credentials.json', '.claude.json', 'cache', 'backups', 'telemetry', 'sessions', 'daemon',
    'shell-snapshots', 'jobs', 'state', 'debug', 'ide', 'statsig', 'stats-cache.json',
  ],
}
