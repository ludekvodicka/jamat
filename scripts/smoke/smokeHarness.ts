/**
 * What every smoke does around the thing it is actually testing: count a check, wait for a
 * condition, sleep, and end.
 *
 * Ten of the eleven held their own `check`, and most of them their own `waitUntil` and `sleep` as
 * well. The copies had begun to differ where it matters least to read and most to run: eight ended a
 * failure with `process.exit(1)` and three with `process.exitCode = 1`, with nothing saying why.
 *
 * **A failed smoke ends, it does not drain.** `process.exitCode = 1` returns to the event loop, and
 * a smoke that has just failed is exactly the one most likely to be holding a Host child, an open
 * socket or an armed timer - so the difference between the two spellings is the difference between
 * a red run and a run that hangs until CI kills it. `SmokeRun.failed` is the one way to end.
 */
export abstract class SmokeHarness {
  private passedChecks = 0

  /** How many checks passed, for the line a smoke prints when it is done. */
  protected get passed(): number {
    return this.passedChecks
  }

  /**
   * How long a wait may take before it is a failure. Per SMOKE rather than per call: what a wait is
   * really bounded by is the machine this one drives - a PTY settles in a moment, an Electron window
   * does not - and threading a number through every call site is how the same budget ends up written
   * in twenty places and changed in one.
   */
  protected get waitMilliseconds(): number {
    return 10_000
  }

  /**
   * One assertion. It THROWS rather than counting a failure, because a smoke drives a real system:
   * the step after a broken one asks about a state nobody reached, and its answer means nothing.
   */
  protected check(description: string, condition: boolean): void {
    if (!condition) throw new Error(`FAILED: ${description}`)
    this.passedChecks += 1
    console.log(`  ok  ${description}`)
  }

  /** Waits for the CONDITION rather than for a duration; the deadline is only how long it may take. */
  protected async waitUntil(condition: () => boolean, failure: string): Promise<void> {
    const deadline = Date.now() + this.waitMilliseconds
    while (Date.now() < deadline) {
      if (condition()) return
      await SmokeHarness.sleep(100)
    }
    throw new Error(failure)
  }

  /** The same, for a condition that has to be asked over the wire. */
  protected async waitUntilAsync(
    condition: () => Promise<boolean>,
    failure: string,
  ): Promise<void> {
    const deadline = Date.now() + this.waitMilliseconds
    while (Date.now() < deadline) {
      if (await condition()) return
      await SmokeHarness.sleep(100)
    }
    throw new Error(failure)
  }

  /** Waiting for something and then counting it as a check, which is the common pair. */
  protected async checkWait(description: string, condition: () => boolean): Promise<void> {
    await this.waitUntil(condition, `FAILED: ${description}`)
    this.check(description, true)
  }

  protected static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}

/** The one way a smoke ends, so that a failure cannot become a hang. */
export class SmokeRun {
  static failed(name: string, error: unknown): never {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
