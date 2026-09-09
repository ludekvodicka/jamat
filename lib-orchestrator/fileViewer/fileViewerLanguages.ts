/**
 * Which language name a file's extension or its bare name gets.
 *
 * A data class with no imports at all, deliberately web-safe, because the renderer's highlighter
 * keeps the GRAMMARS for these names and the two lists had already drifted: `.gitignore` mapped to a
 * `gitignore` no grammar could load, so it opened unhighlighted with nothing said. Shared precisely
 * so the two sides cannot end up disagreeing about a name.
 */
export class FileViewerLanguages {
  static readonly byExtension: Readonly<Record<string, string>> = {
    ts: 'typescript', tsx: 'tsx', cts: 'typescript', mts: 'typescript',
    js: 'javascript', jsx: 'jsx', cjs: 'javascript', mjs: 'javascript',
    json: 'json', jsonc: 'jsonc',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    cs: 'csharp', java: 'java', py: 'python', pyw: 'python', go: 'go', rs: 'rust',
    php: 'php', rb: 'ruby', swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
    ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini',
    xml: 'xml', xsd: 'xml', xsl: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    vue: 'vue', svelte: 'svelte', astro: 'astro', graphql: 'graphql', gql: 'graphql',
    sol: 'solidity', diff: 'diff', patch: 'diff',
  }

  static readonly byName: Readonly<Record<string, string>> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    gnumakefile: 'makefile',
    'cmakelists.txt': 'cmake',
    // `ini` rather than a `gitignore` grammar, because there is no such grammar to load: the
    // highlighter had no branch for the name and quietly drew the file as plain text. `ini` colours
    // the `#` comments and leaves the patterns alone, which is what these files mostly are.
    '.gitignore': 'ini',
    '.gitattributes': 'ini',
    '.editorconfig': 'ini',
    '.npmrc': 'ini',
    '.yarnrc': 'yaml',
  }

  /** Every name these maps can produce, plus the two the document kinds carry on their own. */
  static all(): readonly string[] {
    return [...new Set([
      ...Object.values(FileViewerLanguages.byExtension),
      ...Object.values(FileViewerLanguages.byName),
      // What `FileViewerText.language` answers for a markdown document and for an svg.
      'markdown',
      'xml',
    ])]
  }
}
