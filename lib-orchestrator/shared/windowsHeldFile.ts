import { setTimeout } from 'node:timers/promises'
import { ErrnoCode } from './errnoCode'

/**
 * Retries a file replacement or removal that Windows refuses because another program holds the file.
 *
 * A real-time scanner or the search indexer opens a file right after it is written or renamed, without
 * delete sharing; while it reads, `MoveFileEx`/`ReplaceFile` onto that file and `DeleteFile` answer
 * access denied (EPERM, EACCES) or a sharing violation (EBUSY). A second write of the same file a few
 * milliseconds after the first meets the scan of the first. On an idle machine the scan ends within
 * tens of milliseconds; under a full parallel test run it took longer than 0.6 s, so the pauses add up
 * to about 2.5 s. Other platforms and other codes fail at once.
 */
export class WindowsHeldFile {
  private static readonly heldCodesConst: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])
  static readonly pausesMsConst: readonly number[] = [20, 40, 80, 160, 320, 640, 1280]

  static async retried<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation() }
      catch (error) {
        if (!WindowsHeldFile.held(error) || attempt >= WindowsHeldFile.pausesMsConst.length) throw error
        await setTimeout(WindowsHeldFile.pausesMsConst[attempt])
      }
    }
  }

  /** The same retry for a synchronous caller; the pause blocks its thread, which happens only while the file is held. */
  static retriedSync<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try { return operation() }
      catch (error) {
        if (!WindowsHeldFile.held(error) || attempt >= WindowsHeldFile.pausesMsConst.length) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WindowsHeldFile.pausesMsConst[attempt])
      }
    }
  }

  private static held(error: unknown): boolean {
    return process.platform === 'win32' && WindowsHeldFile.heldCodesConst.has(ErrnoCode.of(error) ?? '')
  }
}
