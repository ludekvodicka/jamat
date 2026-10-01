# autoUpdateWidgets

Plain React widgets for the `autoUpdate` member: a compact status indicator and a panel with the release notes and
the update actions. They use no component library; one CSS file with prefixed class names and CSS custom properties
lets each app match its own look.

**Framework-neutral on purpose:** apps with MUI, with Fluent UI or with their own CSS mount the same widgets. They
import only React and the sibling `autoUpdate` member.

## Components

| Component | Props | Renders |
|---|---|---|
| `AutoUpdateIndicator` | `update` (from `useAutoUpdate`), `onOpen()`, optional `className` | colored dot and state text as one button (opens the panel); "Restart and install" when ready; nothing before the first status |
| `AutoUpdatePanel` | `update`, `open`, `onClose()` | modal panel: state, detail, release name and date, release notes as text, "Check now", "Restart and install", "View on GitHub" (only with a release page), "Close" |

The app decides where they sit: an app bar, a status bar segment or a toolbar chip. Pass `className` to give the
indicator the app's own status-bar item class.

## Theming

`autoUpdateWidgets.css` is imported by the components; the app imports nothing extra. Every class starts with
`auto-update-`. Override the custom properties on any ancestor element:

| Property | Default | Used for |
|---|---|---|
| `--auto-update-text` | `inherit` | indicator text |
| `--auto-update-muted` | `#8a8f98` | dot: off, idle, up to date |
| `--auto-update-working` | `#d9a400` | dot: checking, downloading, installing |
| `--auto-update-attention` | `#2f7de1` | dot: new version available |
| `--auto-update-ready` | `#2e9d57` | dot: ready to install |
| `--auto-update-failed` | `#d64545` | dot: failed |
| `--auto-update-accent`, `--auto-update-accent-text` | `#2f7de1`, `#fff` | primary button, focus ring |
| `--auto-update-border`, `--auto-update-button-bg` | `currentColor`, `transparent` | other buttons |
| `--auto-update-surface`, `--auto-update-surface-text` | `#fff`, `#1d1f23` | panel |
| `--auto-update-notes-bg` | translucent grey | release notes box |
| `--auto-update-backdrop`, `--auto-update-z` | `rgba(0,0,0,0.4)`, `1000` | panel backdrop |
| `--auto-update-radius`, `--auto-update-font` | `4px` / `6px`, `inherit` | corners, panel font |

Example with MUI (`sx` on an ancestor):

```tsx
<Box sx={theme => ({ "--auto-update-accent": theme.palette.secondary.main, "--auto-update-surface": theme.palette.background.paper })}>
```

Example with plain CSS:

```css
.statusbar { --auto-update-accent: var(--accent); --auto-update-ready: var(--ok); --auto-update-failed: var(--err); }
```
