export class SvnCommand {
  static readonly reads = new Set(['status', 'st', 'stat', 'info', 'log', 'diff', 'di', 'cat', 'list', 'ls', 'blame', 'praise', 'annotate', 'ann',
    'propget', 'pget', 'pg', 'proplist', 'plist', 'pl', 'export', 'help', '?', 'h'])

  static of(args: readonly string[]): string | null {
    if (args.some((arg) => ['--help', '-h', '--version'].includes(arg))
      && args.every((arg) => ['--help', '-h', '--version', '--quiet', '-q', '--verbose', '-v'].includes(arg))) return 'help'
    const values = new Set(['--username', '--password', '--password-from-stdin', '--config-dir', '--config-option', '--trust-server-cert-failures',
      '--targets', '--depth', '--set-depth', '--accept', '--revision', '-r', '--changelist', '--cl', '--encoding', '--message', '-m', '--file', '-F'])
    values.delete('--password-from-stdin')
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--') return args[index + 1]?.toLowerCase() ?? null
      if (!arg.startsWith('-')) return arg.toLowerCase()
      if (values.has(arg)) index++
      else if (arg.includes('=') || /^-[rmF].+/.test(arg)) continue
      else if (!['--non-interactive', '--no-auth-cache', '--trust-server-cert', '--force', '--quiet', '-q', '--verbose', '-v', '--xml', '--password-from-stdin'].includes(arg))
        return null
    }
    return null
  }
}
