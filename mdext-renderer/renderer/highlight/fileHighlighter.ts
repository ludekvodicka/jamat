import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'

/**
 * Shiki's own type, not a four-member picture of it.
 *
 * The picture was reached through `as unknown as`, so a rename on a version bump compiled: the
 * method would be `undefined` at runtime, the promise would reject, and both callers swallow a
 * rejection by drawing plain text - everything unhighlighted, nothing reported anywhere.
 */
type ShikiHighlighter = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>

/** Whatever `loadLanguage` takes, taken from `loadLanguage` rather than described again. */
interface ShikiLanguageModule {
  default: Parameters<ShikiHighlighter['loadLanguage']>[0]
}

/**
 * Shiki's `FontStyle` bit flags, named.
 *
 * The enum is a `const enum` in `@shikijs/types`, which erases at compile time and so cannot be
 * imported as a value here; the numbers are its own and are what `codeToTokens` sets.
 */
class FileHighlighterConst {
  static readonly italic = 1
  static readonly bold = 2
  static readonly underline = 4
}

export class FileHighlighter {
  private static highlighter: Promise<ShikiHighlighter> | null = null
  private static readonly languageLoads = new Map<string, Promise<void>>()

  static async html(source: string, language: string): Promise<string> {
    FileHighlighter.assertSize(source)
    const highlighter = await FileHighlighter.instance()
    return highlighter.codeToHtml(source, {
      lang: await FileHighlighter.language(highlighter, language),
      theme: 'github-dark',
    })
  }

  static async lines(source: string, language: string): Promise<readonly string[]> {
    FileHighlighter.assertSize(source)
    const highlighter = await FileHighlighter.instance()
    const result = highlighter.codeToTokens(source, {
      lang: await FileHighlighter.language(highlighter, language),
      theme: 'github-dark',
    })
    return result.tokens.map((line) => line.map((token) => {
      const content = FileHighlighter.escape(token.content)
      const style = token.fontStyle ?? 0
      const styles = [
        token.color ? `color:${token.color}` : '',
        style & FileHighlighterConst.italic ? 'font-style:italic' : '',
        style & FileHighlighterConst.bold ? 'font-weight:bold' : '',
        style & FileHighlighterConst.underline ? 'text-decoration:underline' : '',
      ].filter(Boolean).join(';')
      return styles ? `<span style="${styles}">${content}</span>` : content
    }).join(''))
  }

  private static instance(): Promise<ShikiHighlighter> {
    if (FileHighlighter.highlighter === null)
      FileHighlighter.highlighter = FileHighlighter.create()
    return FileHighlighter.highlighter
  }

  private static async create(): Promise<ShikiHighlighter> {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    return await createHighlighterCore({
      themes: [import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  }

  private static async language(highlighter: ShikiHighlighter, requested: string): Promise<string> {
    const language = FileHighlighter.normalizedLanguage(requested)
    if (language === 'text' || highlighter.getLoadedLanguages().includes(language)) return language
    let loading = FileHighlighter.languageLoads.get(language)
    if (!loading) {
      const grammar = FileHighlighter.grammarsConst[language]
      if (grammar === undefined) return 'text'
      loading = grammar().then((module) => highlighter.loadLanguage(module.default))
      FileHighlighter.languageLoads.set(language, loading)
    }
    try { await loading }
    catch {
      // Forgotten, so the next fence asks again. A rejected promise left in the map meant one failed
      // import - a dev server reloading, a disk hiccup - left that language unhighlighted until the
      // window restarted, and silently, because falling back to plain text is a legitimate answer
      // for a language shiki does not have.
      FileHighlighter.languageLoads.delete(language)
      return 'text'
    }
    return highlighter.getLoadedLanguages().includes(language) ? language : 'text'
  }

  /**
   * Every grammar this window can load, as thunks rather than as a ladder of `else if`.
   *
   * A record, because the SET has to be answerable without loading anything: the library's format
   * registry names a language per file type and the two lists had already drifted - `.gitignore`
   * mapped to a name with no branch here, so it opened unhighlighted with nothing said.
   */
  private static readonly grammarsConst:
    Readonly<Record<string, () => Promise<ShikiLanguageModule>>> = {
    'typescript': () => import('shiki/langs/typescript.mjs'),
    'tsx': () => import('shiki/langs/tsx.mjs'),
    'javascript': () => import('shiki/langs/javascript.mjs'),
    'jsx': () => import('shiki/langs/jsx.mjs'),
    'json': () => import('shiki/langs/json.mjs'),
    'jsonc': () => import('shiki/langs/jsonc.mjs'),
    'bash': () => import('shiki/langs/bash.mjs'),
    'shellscript': () => import('shiki/langs/shellscript.mjs'),
    'powershell': () => import('shiki/langs/powershell.mjs'),
    'python': () => import('shiki/langs/python.mjs'),
    'go': () => import('shiki/langs/go.mjs'),
    'rust': () => import('shiki/langs/rust.mjs'),
    'java': () => import('shiki/langs/java.mjs'),
    'c': () => import('shiki/langs/c.mjs'),
    'cpp': () => import('shiki/langs/cpp.mjs'),
    'csharp': () => import('shiki/langs/csharp.mjs'),
    'sql': () => import('shiki/langs/sql.mjs'),
    'yaml': () => import('shiki/langs/yaml.mjs'),
    'toml': () => import('shiki/langs/toml.mjs'),
    'html': () => import('shiki/langs/html.mjs'),
    'css': () => import('shiki/langs/css.mjs'),
    'scss': () => import('shiki/langs/scss.mjs'),
    'markdown': () => import('shiki/langs/markdown.mjs'),
    'diff': () => import('shiki/langs/diff.mjs'),
    'dockerfile': () => import('shiki/langs/dockerfile.mjs'),
    'makefile': () => import('shiki/langs/makefile.mjs'),
    'cmake': () => import('shiki/langs/cmake.mjs'),
    'php': () => import('shiki/langs/php.mjs'),
    'ruby': () => import('shiki/langs/ruby.mjs'),
    'swift': () => import('shiki/langs/swift.mjs'),
    'kotlin': () => import('shiki/langs/kotlin.mjs'),
    'lua': () => import('shiki/langs/lua.mjs'),
    'solidity': () => import('shiki/langs/solidity.mjs'),
    'vue': () => import('shiki/langs/vue.mjs'),
    'svelte': () => import('shiki/langs/svelte.mjs'),
    'xml': () => import('shiki/langs/xml.mjs'),
    'ini': () => import('shiki/langs/ini.mjs'),
    'perl': () => import('shiki/langs/perl.mjs'),
    'r': () => import('shiki/langs/r.mjs'),
    'objective-c': () => import('shiki/langs/objective-c.mjs'),
    'scala': () => import('shiki/langs/scala.mjs'),
    'fish': () => import('shiki/langs/fish.mjs'),
    'bat': () => import('shiki/langs/bat.mjs'),
    'sass': () => import('shiki/langs/sass.mjs'),
    'less': () => import('shiki/langs/less.mjs'),
    'astro': () => import('shiki/langs/astro.mjs'),
    'graphql': () => import('shiki/langs/graphql.mjs'),
  }

  /** Whether a grammar for this language exists at all, asked without loading it. */
  static supports(language: string): boolean {
    const normalized = FileHighlighter.normalizedLanguage(language)
    return normalized === 'text' || normalized in FileHighlighter.grammarsConst
  }

  private static normalizedLanguage(requested: string): string {
    const language = requested.trim().toLowerCase()
    if (language === 'js') return 'javascript'
    else if (language === 'ts') return 'typescript'
    else if (language === 'sh' || language === 'zsh') return 'bash'
    else if (language === 'ps1') return 'powershell'
    else if (language === 'py') return 'python'
    else if (language === 'c++') return 'cpp'
    else if (language === 'cs') return 'csharp'
    else if (language === 'yml') return 'yaml'
    else if (language === 'md') return 'markdown'
    else if (language === 'rb') return 'ruby'
    else if (language === 'kt') return 'kotlin'
    else if (language === 'sol') return 'solidity'
    else if (language === 'gql') return 'graphql'
    else if (language === 'txt' || language === 'plaintext' || language === 'plain') return 'text'
    return language || 'text'
  }

  private static assertSize(source: string): void {
    const size = new TextEncoder().encode(source).length
    if (size > FileViewerLimits.highlightBytes)
      throw new Error(`Syntax highlighting is limited to ${FileViewerLimits.highlightBytes} bytes`)
  }

  private static escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
}
