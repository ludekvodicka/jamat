export class CliProcess {
  static readonly brokenPipeExitConst = 141

  static installBrokenPipeHandlers(exit: (code: number) => never = process.exit): void {
    process.stdout.on('error', (error) => CliProcess.handleStreamError(error, exit))
    process.stderr.on('error', (error) => CliProcess.handleStreamError(error, exit))
  }

  static handleStreamError(error: unknown, exit: (code: number) => never): void {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') exit(CliProcess.brokenPipeExitConst)
    throw error
  }
}
