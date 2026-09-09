import type { LauncherKeyPreference } from '../../shared/commands'
import { KeyboardSettings } from '../../shared/keyboardSettings'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'

/**
 * Which launcher card Ctrl+T opens, for the surfaces of this document that PRINT a key.
 *
 * Statics rather than an instance, the shape `UiSettingsStore` beside it uses: there is one config
 * per document and one answer in it, so a second store would be a second answer to which key opens
 * what. It is started once per document and read from wherever a key is drawn.
 *
 * It carries no preview and applies nothing: what the keys DO is decided by the native menu, in the
 * main process, off the same section. This is only what the window says about them, which is why a
 * document that never starts it still works and only prints the default pair.
 */
export class KeyboardSettingsStore {
  private static value: LauncherKeyPreference = KeyboardSettings.defaultConst.launcherKeys
  private static readonly subscribers = new Set<() => void>()

  /** Subscribes and reads once; the returned function undoes both. One call per document. */
  static start(): () => void {
    const reader = new IpcSnapshotReader(
      {
        subject: 'The keyboard settings',
        read: () => window.appClient.keyboard.getSettings(),
        subscribe: (onChanged) => window.appClient.onKeyboardSettingsChanged(onChanged),
        reportError: (message) => console.error(message),
      },
      (snapshot) => KeyboardSettingsStore.arrived(snapshot.launcherKeys),
      // A reader that has given up leaves the last known pair on screen. A tooltip naming the key it
      // named a moment ago is worth more than a window that reports a config read on its surface.
      () => {},
    )
    return reader.start()
  }

  static current(): LauncherKeyPreference {
    return KeyboardSettingsStore.value
  }

  /** What this window itself just wrote, told rather than heard back through the coalescing read. */
  static committed(preference: LauncherKeyPreference): void {
    KeyboardSettingsStore.arrived(preference)
  }

  static subscribe(callback: () => void): () => void {
    KeyboardSettingsStore.subscribers.add(callback)
    return () => {
      KeyboardSettingsStore.subscribers.delete(callback)
    }
  }

  /** Everything here is static and outlives any one test, so a test starts from the default. */
  static reset(): void {
    KeyboardSettingsStore.value = KeyboardSettings.defaultConst.launcherKeys
    KeyboardSettingsStore.subscribers.clear()
  }

  private static arrived(preference: LauncherKeyPreference): void {
    if (KeyboardSettingsStore.value === preference) return
    KeyboardSettingsStore.value = preference
    for (const callback of KeyboardSettingsStore.subscribers)
      callback()
  }
}
