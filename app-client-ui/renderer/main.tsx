import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/app.css'

import { HolderShell, MainShell } from './shell/appShell'
import { KeyboardSettingsStore } from './keyboardSettings/keyboardSettingsStore'
import { WindowInfoStore } from './shell/windowInfoStore'
import { UiSettingsStore } from './uiSettings/uiSettingsStore'
import { WheelSpeed } from './uiSettings/wheelSpeed'

const root = document.getElementById('root')
if (!root)
  throw new Error('Renderer root element is missing')

// Awaited, so the stored size is in place before the first paint rather than one repaint after it.
// The stop function is dropped rather than kept: this reader lives exactly as long as the document,
// and there is no moment at which the window still draws text but no longer wants its size.
await UiSettingsStore.startSettled()
// The wheel the same way: one listener for the document, dropped with it. It reads the speed per
// event, so it costs a comparison until somebody moves the slider off 100 %.
WheelSpeed.install()
// Not awaited: nothing is laid out from it. It decides what ONE tooltip says about a key, and a
// window that paints before the first read prints the default pair and corrects itself.
KeyboardSettingsStore.start()
const info = await WindowInfoStore.start()

// No StrictMode on purpose: its dev-only double mount would double every lifecycle probe reading.
// The terminal used to be the second reason and is not one any more - each run of its effect mints
// its own attach id, so a double mount is harmless there and its own test drives exactly that.
if (info.role === 'main')
  createRoot(root).render(<MainShell />)
else if (info.role === 'holder')
  createRoot(root).render(<HolderShell />)
else
  throw new Error(`Unknown workspace role: ${JSON.stringify(info.role)}`)
