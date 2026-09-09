import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'

import { ErrorText } from '../../shared/errorText'

export interface UpdateManagerDeps {
  /**
   * The window a question is asked over, read at call time so it follows whatever is in front. No
   * window is asked unparented rather than refused, the same bargain the dialog service makes: a
   * question nobody can see is worse than one in the wrong place.
   */
  parentWindowOf: () => BrowserWindow | null
}

/**
 * The update path, and every step of it is answered by the person at the machine: the check only
 * FINDS a release, the download happens because they said so, and the install rides a quit they
 * chose. `autoDownload` off is what makes that true - the default has a menu click pull an
 * installer down before anyone was asked whether they wanted one.
 *
 * V1 parked an update until its agent went idle, because installing killed the turn in progress.
 * V3's Host is detached and outlives the client, so a turn survives the restart and that machinery
 * has nothing left to protect. It is deliberately not here.
 *
 * The dialogs are its own rather than the dialog service's because the three of them are one
 * conversation - found, downloaded, ready - and splitting them would put half its words in another
 * file. What is shared with that service is the convention, not the code: the first button is the
 * affirmative one and `cancelId` is the last, so a dialog dismissed without an answer is a no.
 */
export class UpdateManager {
  /**
   * The last error the wired handler put on screen, held by identity alone. Both `checkForUpdates`
   * and `downloadUpdate` emit `error` and THEN reject with the same object, so without this the one
   * failure would ask the same person the same question twice.
   */
  private lastNotifiedError: unknown = null

  constructor(private readonly deps: UpdateManagerDeps) {}

  /**
   * Called once, by the assembly. The `error` listener is not decoration: an emitter with none
   * throws what it emits, so this is what keeps a feed that cannot be reached from taking the
   * process down with it.
   */
  wire(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (error) => {
      this.lastNotifiedError = error
      void this.notify('The update check failed', ErrorText.of(error))
    })
  }

  /** The menu action. It never rejects: a menu click has no owner above it to catch anything. */
  async checkInteractive(): Promise<void> {
    try {
      await this.check()
    } catch (error) {
      // The updater emits `error` before it rejects, so its own failures are already on screen and
      // saying it again would be the same question twice. Anything else - a dialog that could not
      // open - was never the updater's and is still worth showing.
      if (error !== this.lastNotifiedError)
        await this.notify('The update check failed', ErrorText.of(error))
    }
  }

  /*
   * AppJamatV2 review 079: `latest.yml` names its artifacts RELATIVELY, as bare file names, so
   * `new URL(name, updateInfo.files[0].url)` throws ERR_INVALID_URL. Nothing here reads `files` or
   * composes an address at all. Should sibling metadata ever be wanted, the absolute URLs are the
   * ones `provider.resolveFiles(updateInfo)` returns off the provider the check already built -
   * never a URL joined onto a relative one, and never `getFeedURL()`, which is deprecated. Where
   * the feed lives is the `publish` block of the build and is composed by hand nowhere.
   */
  private async check(): Promise<void> {
    const result = await autoUpdater.checkForUpdates()
    // Null is the updater saying it is not active, which in practice is a run from source: there is
    // no installed build to replace. Calling that "up to date" would be a claim nothing checked.
    if (result === null) {
      await this.notify(
        'Updates are checked only in an installed Jamat',
        'This is a development run, so there is nothing to update.',
      )
      return
    }
    if (!result.isUpdateAvailable) {
      await this.notify(
        'Jamat is up to date',
        `The latest published release is ${result.updateInfo.version}.`,
      )
      return
    }
    const version = result.updateInfo.version
    const wanted = await this.askedYes({
      type: 'question',
      message: `Jamat ${version} is available`,
      detail: 'Download it now? Nothing has been downloaded yet.',
      buttons: ['Download', 'Not Now'],
      defaultId: 1,
      cancelId: 1,
    })
    if (!wanted)
      return
    await autoUpdater.downloadUpdate()
    const now = await this.askedYes({
      type: 'question',
      message: `Jamat ${version} is ready to install`,
      detail: 'Restart now to install it, or leave it and it installs when you next quit Jamat.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 1,
      cancelId: 1,
    })
    if (now)
      autoUpdater.quitAndInstall()
  }

  private async notify(message: string, detail: string): Promise<void> {
    await this.answerOf({
      type: 'info', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0,
    })
  }

  private async askedYes(options: MessageBoxOptions): Promise<boolean> {
    return await this.answerOf(options) === 0
  }

  private async answerOf(options: MessageBoxOptions): Promise<number> {
    const parent = this.deps.parentWindowOf()
    const answer = parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options)
    return answer.response
  }
}
