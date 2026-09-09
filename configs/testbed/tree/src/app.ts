/**
 * The file the testbed edits the most. Its three edited regions sit far enough apart that the
 * diff producer makes three separate hunks out of them, which is what the two gutters, the
 * markers and the minimap are there to show.
 */
export class TestbedApp {
  private static readonly nameConst = 'testbed'
  private static readonly versionConst = '1.0.0'

  private readonly started = Date.now()
  private readonly greetings: string[] = []

  static describe(): string {
    return `${TestbedApp.nameConst} ${TestbedApp.versionConst}`
  }

  greet(name: string): string {
    const greeting = `hello, ${name}`
    this.greetings.push(greeting)
    return greeting
  }

  count(): number {
    return this.greetings.length
  }

  uptimeMs(): number {
    return Date.now() - this.started
  }

  last(): string | null {
    return this.greetings.at(-1) ?? null
  }

  reset(): void {
    this.greetings.length = 0
  }

  summary(): string {
    return `${TestbedApp.describe()}: ${this.count()} greetings in ${this.uptimeMs()} ms`
  }

  toJson(): Record<string, unknown> {
    return {
      name: TestbedApp.nameConst,
      version: TestbedApp.versionConst,
      greetings: this.greetings.length,
    }
  }
}
