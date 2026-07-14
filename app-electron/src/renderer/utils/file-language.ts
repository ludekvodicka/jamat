/**
 * Map a file path's extension to a Shiki language id (loaded in `utils/shiki`).
 * Returned value is safe to pass to `DiffView` as `highlightLang` — unknown
 * extensions yield `undefined`, which DiffView treats as "no highlighting";
 * an id that isn't loaded also falls back to plain text in the highlighter.
 *
 * Shared by FileViewer and SessionChanges' diff pane so both render the
 * same syntax colors for the same file types. Keep the ids in step with the
 * lang list loaded in `utils/shiki.ts`.
 */

const EXT_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  mdext: 'markdown',
  py: 'python',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  dockerfile: 'dockerfile',
  diff: 'diff',
  patch: 'diff',
}

export function langForPath(filePath: string): string | undefined {
  const fileName = filePath.split(/[\\/]/).pop() ?? ''
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MAP[ext]
}
