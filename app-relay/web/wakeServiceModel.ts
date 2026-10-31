import type { LauncherState, WakeServiceProblem } from '../app/miniWolClient.js';

export type WakeServiceState =
  | { state: 'ready'; version: string; computers: { id: string; hasLauncher: boolean }[] }
  | { state: 'not-configured' | 'unreachable' | 'needs-update' | 'key-rejected' | 'protocol-error' };
export type CardAction = { kind: 'idle' | 'waking' | 'wake-timeout' | 'starting' | 'start-timeout' }
  | { kind: 'problem'; problem: WakeServiceProblem; retryAfter?: number };
export interface CardView {
  launcherText?: string;
  showWake: boolean;
  showStart: boolean;
  showSetup: boolean;
  notice?: string;
  readProblemText?: string;
}

function launcherText(state: LauncherState): string {
  switch (state) {
    case 'ready': return 'Jamat je připravený.';
    case 'stopped': return 'Jamat je vypnutý.';
    case 'starting': return 'Jamat se spouští. Za chvíli obnovte stav.';
    case 'failed': return 'Spuštění Jamatu selhalo. Zkontrolujte spouštěč na počítači.';
    case 'unavailable': return 'Spouštěč Jamatu není dostupný. Probuďte počítač a obnovte stav.';
    default: throw new Error('Unknown launcher state');
  }
}

export function launcherErrorText(error: string | undefined): string | undefined {
  switch (error) {
    case 'target-missing': return 'Uložený program nebo pracovní adresář chybí. Změňte cíl v Nastavení > Autolauncher na počítači.';
    case 'target-invalid': return 'Uložený cíl spouštění není platný. Zkontrolujte Nastavení > Autolauncher na počítači.';
    case 'launch-failed': return 'Program se nepodařilo spustit nebo skončil před připravením Jamatu. Zkontrolujte log spouštěče na počítači.';
    case 'readiness-timeout': return 'Jamat neodpověděl v časovém limitu. Zkontrolujte spouštěč na počítači.';
    case 'profile-unavailable': return 'Nelze ověřit nastavený profil Jamatu. Zkontrolujte Nastavení > Autolauncher na počítači.';
    default: return undefined;
  }
}

export function cardView(peerOnline: boolean, service: WakeServiceState, pcId: string,
    launcher: LauncherState | undefined, action: CardAction = { kind: 'idle' },
    readProblem?: { problem: WakeServiceProblem; retryAfter?: number }, launcherError?: string): CardView {
  const computer = service.state === 'ready' ? service.computers.find(pc => pc.id === pcId) : undefined;
  const view: CardView = { showWake: !!computer && !peerOnline, showStart: !!computer?.hasLauncher && !peerOnline,
    showSetup: !!computer?.hasLauncher };
  if (readProblem) view.readProblemText = problemText(readProblem.problem, readProblem.retryAfter);
  if (peerOnline) {
    view.launcherText = 'Jamat je připojený.';
    if (action.kind === 'problem') view.notice = problemText(action.problem, action.retryAfter);
    return view;
  }
  if (computer?.hasLauncher && launcher)
    view.launcherText = launcher === 'failed' ? launcherErrorText(launcherError) ?? launcherText(launcher) : launcherText(launcher);
  switch (action.kind) {
    case 'idle': break;
    case 'waking': view.notice = 'Paket odeslán. Probuzení zatím není ověřené.'; break;
    case 'wake-timeout': view.notice = 'Počítač zatím neodpovídá.'; break;
    case 'starting':
      if (launcher !== 'ready' && launcher !== 'failed') view.notice = 'Jamat se spouští. Za chvíli obnovte stav.';
      break;
    case 'start-timeout': view.notice = 'Jamat se zatím nepřipojil.'; break;
    case 'problem': view.notice = problemText(action.problem, action.retryAfter); break;
    default: throw new Error('Unknown wake-service action');
  }
  return view;
}

export function invitationWarning(label: string): string {
  return `Pozvánku použijte přímo na počítači ${label} v domácí síti, ne přes VPN. Nová pozvánka zneplatní předchozí.`;
}

export function invitationInstructions(label: string): string[] {
  return [`Na počítači ${label} otevřete Jamat a přejděte do Nastavení → Autolauncher.`,
    'Zkopírujte celou pozvánku níže a vložte ji do pole v nastavení.',
    'Potvrďte instalaci spouštěče pro aktuální profil.'];
}

export function invitationCountdown(seconds: number): string {
  if (seconds <= 0) return 'Pozvánka vypršela. Vytvořte novou.';
  const remaining = Math.ceil(seconds);
  return `Platí ještě ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
}

export function footerText(service: WakeServiceState): string {
  switch (service.state) {
    case 'ready': return `Služba probouzení ${service.version}`;
    case 'not-configured': return 'Služba probouzení není nastavená.';
    case 'unreachable': return 'Služba probouzení není dostupná.';
    case 'needs-update': return 'Služba probouzení potřebuje aktualizaci.';
    case 'key-rejected': return 'Služba probouzení odmítla přístupový klíč.';
    case 'protocol-error': return 'Služba probouzení vrátila neočekávanou odpověď.';
    default: throw new Error('Unknown wake-service state');
  }
}

export function problemText(problem: WakeServiceProblem, retryAfter?: number): string {
  switch (problem) {
    case 'unreachable': return 'Služba probouzení není dostupná.';
    case 'needs-update': return 'Služba probouzení potřebuje aktualizaci.';
    case 'key-rejected': return 'Služba probouzení odmítla přístupový klíč.';
    case 'unknown-computer': return 'Počítač není nastavený ve službě probouzení.';
    case 'no-launcher': return 'Počítač nemá nastavený spouštěč Jamatu.';
    case 'rate-limited': return `Příliš mnoho požadavků, zkuste to za ${retryAfter ?? 1} s.`;
    case 'wol-send-failed': return 'Paket se nepodařilo odeslat. Zkuste to znovu.';
    case 'launcher-unavailable': return 'Jamat se nepodařilo spustit. Zkontrolujte, že je počítač zapnutý a jeho spouštěč dostupný, a zkuste to znovu.';
    case 'protocol-error': return 'Služba probouzení vrátila neočekávanou odpověď.';
    default: throw new Error('Unknown wake-service problem');
  }
}
