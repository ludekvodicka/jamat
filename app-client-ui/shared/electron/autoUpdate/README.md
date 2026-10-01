# autoUpdate

Auto-update for an Electron app published through GitHub Releases with `electron-updater`: it checks for a new
version after start and periodically, downloads it in the background, shows the state in the renderer and installs
it on "Restart and install" or on the next normal quit. The code has no UI library and no imports outside this
member, so any Electron app can mount it.

## Behavior

| Build | Mode | What happens |
|---|---|---|
| Not packaged (development run) | `off` | No updater access, the renderer shows the reason |
| Installed Windows (NSIS), Linux AppImage or deb | `automatic` | First check after 45 s, then every 120 min; a found release downloads in the background; `ready` offers "Restart and install" (`quitAndInstall(false, true)`); a ready update also installs on the next normal quit |
| Windows portable, unsigned macOS | `notify` | Check only; the renderer shows the new version and the release page |
| A build without `app-update.yml` | `off` | "This build has no update feed." |

- A failed background check keeps the previous state and is logged (offline is not an update failure). A failed
  manual check or download shows `failed` with a retry.
- No consent prompt, no snooze, no automatic restart and no OS notification: an app adds those itself if it needs
  them, from `subscribe()`.
- Release notes arrive as plain text (`DtoAutoUpdateRelease.notes`); the GitHub HTML is converted in the main process.
- The release page URL never comes from the renderer: main composes it with the app's `releasePageUrl` and opens it
  only for `https:` and an allowed host (`github.com` by default).

## Folders

| Folder | Runs in | Content |
|---|---|---|
| `common/` | every process | `DtoAutoUpdateStatus`, `AutoUpdateApi`, `AutoUpdateConst` (channels, timings), `AutoUpdateView` (text, tone, actions) |
| `main/` | main process | `AutoUpdateMain` (composition for a real app), `AutoUpdateManager`, `AutoUpdateRuntime`, `AutoUpdateReleaseNotes`, `AutoUpdateIpc`, `AutoUpdateLogConsole` |
| `preload/` | preload | `AutoUpdateBridge.create(ipcRenderer)` |
| `renderer/` | renderer | `useAutoUpdate(api)`, `AutoUpdateStore` |

The widgets are the sibling member `autoUpdateWidgets`.

## Wiring

Main process, once per app (an `AxHubModule` calls `start()` in `onStartListening` and `stop()` in `onStopListening`):

```ts
import { AutoUpdateMain } from "<shared>/electron/autoUpdate/main/autoUpdateMain";

const autoUpdate = new AutoUpdateMain({
  releasePageUrl: version => version
    ? `https://github.com/<owner>/<repo>/releases/tag/v${version}`
    : "https://github.com/<owner>/<repo>/releases",
  // optional: backgroundChecks, intervalMinutes, allowedHosts, log (info/warn/error)
});
autoUpdate.start();          // registers the IPC handlers, then starts the timers
app.on("will-quit", () => autoUpdate.stop());
```

Preload: nest the bridge into the app's existing exposed object, no second `contextBridge` global:

```ts
import { AutoUpdateBridge } from "<shared>/electron/autoUpdate/preload/autoUpdateBridge";

contextBridge.exposeInMainWorld("appApi", { ...existingApi, autoUpdate: AutoUpdateBridge.create(ipcRenderer) });
```

Renderer:

```tsx
const update = useAutoUpdate(window.appApi.autoUpdate);
const [open, setOpen] = useState(false);
<AutoUpdateIndicator update={update} onOpen={() => setOpen(true)} />
<AutoUpdatePanel update={update} open={open} onClose={() => setOpen(false)} />
```

## Consumer requirements

- `electron-updater` is declared by this member; `electron` and `react` belong to the consuming app.
- The packaged app needs an electron-builder `publish` block, so `app-update.yml` exists in its resources.
- A tray app that hides its window on close must let the app quit when the state becomes `installing`.
- **TypeScript in a two-program app:** the node program excludes `electron/*/renderer` and `electron/autoUpdateWidgets`;
  the DOM program includes `electron/*/common`, `electron/*/renderer` and `electron/autoUpdateWidgets`.
- **Tests** use vitest and chai and run in the Electron template; other consumers exclude the member tests.
- **Public repositories:** an app that publishes its source carries these files as part of its tree. A later revision
  of this member reaches that public repository only when the app is committed and published again.
