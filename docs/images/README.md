# Images

Everything the public repository shows: the brand assets in `logo/`, and the screenshots the
top-level `README.md` embeds.

This is the only part of `docs/` that ships. The export gate forbids `docs/**` and makes one
exception for `docs/images/**`, so a note dropped anywhere else under `docs/` stays internal and a
note dropped here is published.

## Logo and icons

All derived from one concept: the `J_` monogram, a prompt waiting for input. A sky-blue **J** with a
purple **cursor** block on a dark rounded card.

Palette: J `#56c0f5` · cursor `#c06bff` · card `#0d1117` · border `#2d333b`.

| File | Use |
| --- | --- |
| `logo/jamat-icon.svg` | Vector source of the icon |
| `logo/jamat.ico` | Windows icon source, 16 to 256 px |
| `logo/jamat-256.png` · `logo/jamat-512.png` · `logo/jamat-1024.png` | Raster icon for macOS and Linux packaging, and for general use |
| `logo/favicon.ico` · `logo/favicon.svg` · `logo/favicon-16.png` · `logo/favicon-32.png` · `logo/apple-touch-icon.png` | Web favicon set |
| `logo/jamat-banner.png` · `logo/jamat-banner.svg` | Logo lockup, icon plus wordmark, used at the top of the README |

The raster and `.ico` assets were generated from the two SVGs with `@resvg/resvg-js` and
`png-to-ico`.

**The packaging icons are separate files.** electron-builder reads
`app-client-ui/buildResources/icon.{ico,icns,png}`, not this directory. They were derived from the
same sources, and a change to the brand has to be carried into both places by hand.

## Screenshots

Six shots, in the order the README uses them. Capture them from a running client and put them here
under exactly these names.

| # | File | Shows |
| --- | --- | --- |
| 01 | `01-workspace.png` | The main window: the sessions tree on the left, dockview tabs across the middle, a live agent session running in a terminal panel |
| 02 | `02-launcher.png` | The launcher overlay open over a project: the projects screen, then the new-session card with agent, model and isolation |
| 03 | `03-file-changes.png` | The File Changes view with a diff open, showing which baseline it is diffed against |
| 04 | `04-mdext.png` | A document rendered by the file viewer: a diagram, a table and highlighted code on one page |
| 05 | `05-remote.png` | A paired computer's sessions in the sessions tree, under the Remote section |
| 06 | `06-status-bar.png` | The status bar in detail: Host, the model and context readout, and the rate meters |

### Capture notes

- **Capture from demo material.** Point the client at throwaway project folders with neutral names
  and run a short session in them. A real working tree puts client names, internal paths and file
  names on screen, and every one of those is permanent once published.
- **Images are not scanned.** The export gate decodes text files and looks for owner tokens; a
  `.png` is skipped as a binary payload. Nothing catches an internal path, a hostname, an e-mail
  address or a token that is visible *inside* a screenshot. Read every shot at full size before
  committing it.
- **Check the places that leak quietly**: the window title bar, breadcrumbs and path rows, the
  agent's own welcome banner, terminal prompts, the project list in the launcher, tab titles, and
  the peer name and fingerprint in anything remote.
- **Redact rather than crop** when a shot needs one identifying element to make sense. A blur over
  the peer's hostname keeps the shot readable; a crop that removes the surrounding context usually
  does not.
- **One window, real size.** Capture the window rather than the whole desktop, at a normal window
  size, with the light or dark theme the README's other shots use. Do not scale afterwards: the
  README sets its own display width.
- **Keep them small.** A PNG of a single window should be well under 500 KB. These files live in
  the repository forever.
