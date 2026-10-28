import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { RemoteControlTerminalPeekDto } from '../../lib-orchestrator/remoteControl/remoteControlApi.types';

export class TerminalPreview {
  private readonly host: HTMLElement;
  private terminal: Terminal | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  show(projection: RemoteControlTerminalPeekDto['snapshot']['projection'], ready: () => void): void {
    this.clear();
    const screen = document.createElement('div');
    screen.className = 'terminal-screen';
    screen.setAttribute('aria-label', 'Náhled terminálu, pouze pro čtení');
    this.host.append(screen);
    const terminal = new Terminal({
      cols: projection.cols, rows: projection.rows,
      disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.2,
      scrollback: 1000, allowProposedApi: true, screenReaderMode: true,
      mouseEventsRequireAlt: true,
      linkHandler: { activate() {} },
      theme: { background: '#16161e', foreground: '#e0e1ed', selectionBackground: '#41425a' },
    });
    this.terminal = terminal;
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    terminal.open(screen);
    if (terminal.textarea) {
      terminal.textarea.readOnly = true;
      terminal.textarea.setAttribute('inputmode', 'none');
    }
    terminal.write(projection.screen, () => {
      if (this.terminal !== terminal) return;
      terminal.scrollToBottom();
      ready();
    });
  }

  clear(): void {
    this.terminal?.dispose();
    this.terminal = null;
    this.host.replaceChildren();
  }
}
