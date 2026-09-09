import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UpdateManager } from './updateManager'

/** Hoisted with the mock factories: `vi.mock` runs before any top-level statement of this file. */
const { dialogMock, updaterMock, updater } = vi.hoisted(() => {
  interface ShownDialog {
    parent: unknown
    type: string | undefined
    message: string
    detail: string | undefined
    buttons: readonly string[]
  }

  interface MessageBoxOptionsLike {
    type?: string
    message: string
    detail?: string
    buttons?: string[]
  }

  const dialogMock = {
    shown: [] as ShownDialog[],
    /** What the person clicks, in order. Past the end is the first button. */
    answers: [] as number[],
    showMessageBox: (...args: unknown[]): Promise<{ response: number }> => {
      const parented = args.length > 1
      const options = (parented ? args[1] : args[0]) as MessageBoxOptionsLike
      dialogMock.shown.push({
        parent: parented ? args[0] : null,
        type: options.type,
        message: options.message,
        detail: options.detail,
        buttons: options.buttons ?? [],
      })
      return Promise.resolve({ response: dialogMock.answers.shift() ?? 0 })
    },
  }

  const updater = {
    /** Every property the manager assigns, in order: what "exactly the two flags" is read from. */
    writes: [] as [string, unknown][],
    calls: [] as string[],
    listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
    checkResult: null as unknown,
    checkError: null as Error | null,
    downloadError: null as Error | null,
    emit: (event: string, ...args: unknown[]): void => {
      for (const listener of updater.listeners.get(event) ?? [])
        listener(...args)
    },
  }

  const target = {
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      updater.listeners.set(event, [...updater.listeners.get(event) ?? [], listener])
    },
    checkForUpdates: (): Promise<unknown> => {
      updater.calls.push('checkForUpdates')
      if (updater.checkError === null)
        return Promise.resolve(updater.checkResult)
      // What electron-updater 6.8.9 itself does: the failure is EMITTED and then thrown, which is
      // why one failed check must not put two dialogs on the screen.
      updater.emit('error', updater.checkError)
      return Promise.reject(updater.checkError)
    },
    downloadUpdate: (): Promise<string[]> => {
      updater.calls.push('downloadUpdate')
      if (updater.downloadError === null)
        return Promise.resolve(['Jamat-Setup-3.0.0.exe'])
      updater.emit('error', updater.downloadError)
      return Promise.reject(updater.downloadError)
    },
    quitAndInstall: (): void => {
      updater.calls.push('quitAndInstall')
    },
    /** Deprecated, and review 079's second half. Recorded first, so a call is named not guessed. */
    getFeedURL: (): string => {
      updater.calls.push('getFeedURL')
      throw new Error('getFeedURL must never be called')
    },
  }

  const updaterMock = new Proxy(target, {
    set: (holder, key, value: unknown) => {
      updater.writes.push([String(key), value])
      ;(holder as Record<string | symbol, unknown>)[key] = value
      return true
    },
  })

  return { dialogMock, updaterMock, updater }
})

vi.mock('electron', () => ({ dialog: dialogMock }))
vi.mock('electron-updater', () => ({ autoUpdater: updaterMock }))

describe('app-client-ui/app/update/updateManager', () => {
  const parentWindow = { id: 'main-window' }

  /**
   * The shape `latest.yml` really has: the artifact url is RELATIVE, a bare file name. AppJamatV2
   * review 079 is what this fixture stands for - anything resolving a sibling with
   * `new URL(name, files[0].url)` throws ERR_INVALID_URL against exactly this - so every test here
   * runs against relative urls and none of them may fail.
   */
  function updateInfoOf(version: string): unknown {
    return {
      version,
      releaseDate: '2026-08-31T00:00:00.000Z',
      path: `Jamat-Setup-${version}.exe`,
      files: [{ url: `Jamat-Setup-${version}.exe`, sha512: 'sha', size: 1 }],
    }
  }

  function build(window: unknown = parentWindow): UpdateManager {
    return new UpdateManager({
      parentWindowOf: () => window as never,
    })
  }

  /** Wired, which is the state every check runs in: AppHub wires it as it builds it. */
  function wired(window: unknown = parentWindow): UpdateManager {
    const manager = build(window)
    manager.wire()
    return manager
  }

  function messages(): string[] {
    return dialogMock.shown.map((dialog) => dialog.message)
  }

  beforeEach(() => {
    dialogMock.shown = []
    dialogMock.answers = []
    updater.writes = []
    updater.calls = []
    updater.listeners.clear()
    updater.checkResult = null
    updater.checkError = null
    updater.downloadError = null
  })

  it('sets exactly the two flags and listens for exactly the error event', () => {
    wired()

    expect(updater.writes).toEqual([['autoDownload', false], ['autoInstallOnAppQuit', true]])
    expect([...updater.listeners.keys()]).toEqual(['error'])
    expect(updater.calls).toEqual([])
  })

  it('puts an updater error on the screen and throws nothing', async () => {
    wired()

    expect(() => updater.emit('error', new Error('the feed could not be reached'))).not.toThrow()
    await Promise.resolve()

    expect(dialogMock.shown).toEqual([{
      parent: parentWindow,
      type: 'info',
      message: 'The update check failed',
      detail: 'the feed could not be reached',
      buttons: ['OK'],
    }])
  })

  /*
   * The failure is emitted AND thrown by the same call, so the naive shape - a listener that
   * notifies plus a catch that notifies - asks the same person the same question twice.
   */
  it('reports a failed check once, and resolves rather than rejecting', async () => {
    updater.checkError = new Error('getaddrinfo ENOTFOUND github.com')

    await expect(wired().checkInteractive()).resolves.toBeUndefined()

    expect(messages()).toEqual(['The update check failed'])
    expect(dialogMock.shown[0].detail).toBe('getaddrinfo ENOTFOUND github.com')
    expect(updater.calls).toEqual(['checkForUpdates'])
  })

  it('says so and downloads nothing when the installed build is the latest', async () => {
    updater.checkResult = { isUpdateAvailable: false, updateInfo: updateInfoOf('3.0.0') }

    await wired().checkInteractive()

    expect(messages()).toEqual(['Jamat is up to date'])
    expect(dialogMock.shown[0].detail).toBe('The latest published release is 3.0.0.')
    expect(updater.calls).toEqual(['checkForUpdates'])
  })

  /**
   * `checkForUpdates` answers null when the updater is not active, which in practice is a run from
   * source. Calling that "up to date" would be a claim nothing checked.
   */
  it('distinguishes a development run from an up-to-date one', async () => {
    updater.checkResult = null

    await wired().checkInteractive()

    expect(messages()).toEqual(['Updates are checked only in an installed Jamat'])
    expect(updater.calls).toEqual(['checkForUpdates'])
  })

  it('downloads nothing when the offer is declined', async () => {
    updater.checkResult = { isUpdateAvailable: true, updateInfo: updateInfoOf('3.1.0') }
    dialogMock.answers = [1]

    await wired().checkInteractive()

    expect(messages()).toEqual(['Jamat 3.1.0 is available'])
    expect(dialogMock.shown[0].buttons).toEqual(['Download', 'Not Now'])
    expect(updater.calls).toEqual(['checkForUpdates'])
  })

  it('downloads on consent and leaves the install to the next quit', async () => {
    updater.checkResult = { isUpdateAvailable: true, updateInfo: updateInfoOf('3.1.0') }
    dialogMock.answers = [0, 1]

    await wired().checkInteractive()

    expect(messages()).toEqual(['Jamat 3.1.0 is available', 'Jamat 3.1.0 is ready to install'])
    expect(dialogMock.shown[1].buttons).toEqual(['Restart Now', 'Later'])
    expect(updater.calls).toEqual(['checkForUpdates', 'downloadUpdate'])
  })

  it('installs at once when the restart is taken', async () => {
    updater.checkResult = { isUpdateAvailable: true, updateInfo: updateInfoOf('3.1.0') }
    dialogMock.answers = [0, 0]

    await wired().checkInteractive()

    expect(updater.calls).toEqual(['checkForUpdates', 'downloadUpdate', 'quitAndInstall'])
  })

  /**
   * Review 079, as a gate rather than a comment: the fixture's artifact urls are relative and the
   * deprecated `getFeedURL` throws when it is touched, so a manager that resolved either by hand
   * would land in the catch and show "The update check failed" instead of the two questions below.
   */
  it('reads no feed url and no artifact url of its own', async () => {
    updater.checkResult = { isUpdateAvailable: true, updateInfo: updateInfoOf('3.1.0') }
    dialogMock.answers = [0, 1]

    await wired().checkInteractive()

    expect(updater.calls).not.toContain('getFeedURL')
    expect(messages()).toEqual(['Jamat 3.1.0 is available', 'Jamat 3.1.0 is ready to install'])
  })

  it('reports a failed download once and never reaches the install', async () => {
    updater.checkResult = { isUpdateAvailable: true, updateInfo: updateInfoOf('3.1.0') }
    updater.downloadError = new Error('the installer could not be written')
    dialogMock.answers = [0]

    await expect(wired().checkInteractive()).resolves.toBeUndefined()

    expect(messages()).toEqual(['Jamat 3.1.0 is available', 'The update check failed'])
    expect(updater.calls).toEqual(['checkForUpdates', 'downloadUpdate'])
  })

  it('asks unparented rather than not at all when no window is open', async () => {
    updater.checkResult = { isUpdateAvailable: false, updateInfo: updateInfoOf('3.0.0') }

    await wired(null).checkInteractive()

    expect(dialogMock.shown.map((dialog) => dialog.parent)).toEqual([null])
  })
})
