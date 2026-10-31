import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { LauncherState, WakeServiceProblem } from '../app/miniWolClient.js';
import { cardView, footerText, problemText, invitationCountdown, invitationWarning, invitationInstructions, type WakeServiceState } from './wakeServiceModel.js';
import * as WakeServiceModel from './wakeServiceModel.js';

const ready: WakeServiceState = { state: 'ready', version: '2.0.0', computers: [
  { id: 'office', hasLauncher: true }, { id: 'plain', hasLauncher: false },
] };

test('missing target explains repair while old responses and online peers keep their behavior', () => {
  assert.match(cardView(false, ready, 'office', 'failed', undefined, undefined, 'target-missing').launcherText!, /Autolauncher/);
  assert.equal(cardView(false, ready, 'office', 'failed', undefined, undefined, 'C:/private.exe').launcherText,
    cardView(false, ready, 'office', 'failed').launcherText);
  assert.equal(cardView(true, ready, 'office', 'failed', undefined, undefined, 'target-missing').launcherText, 'Jamat je připojený.');
});

test('online peer wins and only MiniWol computers offer wake', () => {
  assert.deepEqual(cardView(true, ready, 'office', 'unavailable', { kind: 'waking' }), {
    launcherText: 'Jamat je připojený.', showWake: false, showStart: false, showSetup: true,
  });
  assert.equal(cardView(false, ready, 'laptop', undefined).showWake, false);
  assert.equal(cardView(false, ready, 'plain', undefined).showWake, true);
  assert.equal(cardView(false, ready, 'plain', undefined).launcherText, undefined);
  assert.deepEqual(cardView(false, { state: 'needs-update' }, 'office', 'ready'), {
    showWake: false, showStart: false, showSetup: false,
  });
  assert.equal(footerText({ state: 'needs-update' }), 'Služba probouzení potřebuje aktualizaci.');
  assert.equal(footerText(ready), 'Služba probouzení 2.0.0');
});

test('invitation instructions, warning and countdown describe expiry and replacement', () => {
  for (const [seconds, text] of [[300, 'Platí ještě 5:00'], [61, 'Platí ještě 1:01'], [1, 'Platí ještě 0:01'],
    [0, 'Pozvánka vypršela. Vytvořte novou.']] as const)
    assert.equal(invitationCountdown(seconds), text);
  assert.equal(invitationWarning('Local PC'), 'Pozvánku použijte přímo na počítači Local PC v domácí síti, ne přes VPN. Nová pozvánka zneplatní předchozí.');
  assert.deepEqual(invitationInstructions('Local PC'), [
    'Na počítači Local PC otevřete Jamat a přejděte do Nastavení → Autolauncher.',
    'Zkopírujte celou pozvánku níže a vložte ji do pole v nastavení.',
    'Potvrďte instalaci spouštěče pro aktuální profil.',
  ]);
});

test('launcher states and wake notices retain their Czech meanings', () => {
  const texts: Record<LauncherState, string> = {
    ready: 'Jamat je připravený.', stopped: 'Jamat je vypnutý.', starting: 'Jamat se spouští. Za chvíli obnovte stav.',
    failed: 'Spuštění Jamatu selhalo. Zkontrolujte spouštěč na počítači.',
    unavailable: 'Spouštěč Jamatu není dostupný. Probuďte počítač a obnovte stav.',
  };
  for (const [state, text] of Object.entries(texts))
    assert.equal(cardView(false, ready, 'office', state as LauncherState).launcherText, text);
  assert.equal(cardView(false, ready, 'office', undefined, { kind: 'waking' }).notice, 'Paket odeslán. Probuzení zatím není ověřené.');
  assert.equal(cardView(false, ready, 'office', undefined, { kind: 'wake-timeout' }).notice, 'Počítač zatím neodpovídá.');
});

test('all problems and service failures have Czech text and unknown variants throw', () => {
  const problems: WakeServiceProblem[] = ['unreachable', 'needs-update', 'key-rejected', 'unknown-computer',
    'no-launcher', 'rate-limited', 'wol-send-failed', 'launcher-unavailable', 'protocol-error'];
  for (const problem of problems) assert.ok(problemText(problem).length > 15);
  assert.equal(problemText('rate-limited', 3), 'Příliš mnoho požadavků, zkuste to za 3 s.');
  for (const state of ['not-configured', 'unreachable', 'needs-update', 'key-rejected', 'protocol-error'] as const)
    assert.ok(footerText({ state }).length > 15);
  assert.throws(() => problemText('unexpected' as WakeServiceProblem), /Unknown/);
  assert.throws(() => footerText({ state: 'unexpected' } as unknown as WakeServiceState), /Unknown/);
});

test('start stays visible offline and its outcome yields to failure, readiness and online peer', () => {
  assert.equal(cardView(false, ready, 'office', 'starting', { kind: 'starting' }).notice, 'Jamat se spouští. Za chvíli obnovte stav.');
  const failed = cardView(false, ready, 'office', 'failed', { kind: 'starting' });
  assert.equal(failed.launcherText, 'Spuštění Jamatu selhalo. Zkontrolujte spouštěč na počítači.');
  assert.equal(failed.notice, undefined);
  assert.equal(failed.showStart, true);
  const online = cardView(true, ready, 'office', 'starting', { kind: 'starting' });
  assert.equal(online.launcherText, 'Jamat je připojený.');
  assert.equal(online.notice, undefined);
  assert.equal(online.showStart, false);
  const expired = cardView(false, ready, 'office', 'starting', { kind: 'start-timeout' });
  assert.equal(expired.launcherText, 'Jamat se spouští. Za chvíli obnovte stav.');
  assert.equal(expired.notice, 'Jamat se zatím nepřipojil.');
  assert.equal(cardView(false, ready, 'plain', undefined).showStart, false);
});

interface PageElement {
  tag: string;
  textContent: string;
  disabled: boolean;
  value?: string;
  readOnly?: boolean;
  onclick?: () => Promise<void>;
  children: PageElement[];
  append(...children: PageElement[]): void;
  appendChild(child: PageElement): void;
  replaceChildren(...children: PageElement[]): void;
  setAttribute(): void;
}

function pageHarness(send: (path: string, options?: RequestInit) => Promise<unknown>, responseStatus = 200) {
  const element = (tag: string): PageElement => ({ tag, textContent: '', disabled: false, children: [],
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }, setAttribute() {},
  });
  const list = element('div');
  const footer = element('footer');
  const copied: string[] = [];
  const redirects: string[] = [];
  const navigations: string[] = [];
  const intervals = new Map<number, { callback: () => Promise<void>; milliseconds: number }>();
  const timeouts = new Map<number, { callback: () => void; milliseconds: number }>();
  let timer = 0;
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('// --- Init ---')[0];
  const api = runInNewContext(script + `
    ${responseStatus === 200 ? 'globalApi = send;' : ''}
    wakeService = { state: 'ready', version: '2.0.0', computers: [{ id: 'office', hasLauncher: true }] };
    allPcs = [{ id: 'office', label: 'Local PC', online: false }];
    ({ runWakeAction, startWakePoll, stopWakePoll, renderPcCards, refreshWakeService, refreshLauncher,
      action: () => wakeActions.get('office'), launcher: () => launcherStates.get('office'),
      service: () => wakeService, readProblem: () => launcherReadProblems.get('office'),
      polling: () => wakePolls.has('office'), refresh: () => renderPcCards() });`, {
    send, WakeServiceModel, document: { createElement: element,
      getElementById: (id: string) => id === 'wake-service-status' ? footer : list },
    performance: { now: () => 0 }, navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    window: { location: { replace: (path: string) => redirects.push(path), assign: (path: string) => navigations.push(path) } },
    fetch: async (path: string, options?: RequestInit) => ({ status: responseStatus, json: () => send(path, options) }),
    setInterval: (callback: () => Promise<void>, milliseconds: number) => { intervals.set(++timer, { callback, milliseconds }); return timer; },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void, milliseconds: number) => { timeouts.set(++timer, { callback, milliseconds }); return timer; },
    clearTimeout: (id: number) => timeouts.delete(id),
  }) as { runWakeAction(id: string, action: string): Promise<void>; renderPcCards(): void; refresh(): void;
    refreshWakeService(): Promise<void>; refreshLauncher(id: string): Promise<string | undefined>;
    action(): { kind: string; problem?: string }; launcher(): string; polling(): boolean;
    service(): WakeServiceState; readProblem(): { problem: string } | undefined };
  const buttons = () => list.children[0].children[3].children.filter(child => child.tag === 'button');
  return { api, buttons, intervals, timeouts, list, footer, copied, redirects, navigations };
}

test('actual page keeps one in-flight start across rerenders and disables its buttons', async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const page = pageHarness(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = page.api.runWakeAction('office', 'start');
  assert.ok(page.buttons().every(button => button.disabled));
  page.api.refresh();
  assert.ok(page.buttons().every(button => button.disabled));
  await page.api.runWakeAction('office', 'start');
  assert.equal(calls, 1);
  finish({ state: 'starting' });
  await first;
  assert.ok(page.buttons().every(button => !button.disabled));
  assert.equal(page.api.action().kind, 'starting');
  assert.equal([...page.intervals.values()][0].milliseconds, 3000);
  assert.equal([...page.timeouts.values()][0].milliseconds, 180000);
});

test('actual page polls only status, stops on ready or failed and ends at its deadline', async () => {
  for (const end of ['ready', 'failed', 'timeout']) {
    const mutations: string[] = [];
    let state = 'starting';
    const page = pageHarness(async (path, options) => {
      if (options?.method === 'POST') mutations.push(path);
      return path.startsWith('/pc-status') ? { online: false } : { state };
    });
    await page.api.runWakeAction('office', 'start');
    state = end === 'timeout' ? 'starting' : end;
    await [...page.intervals.values()][0].callback();
    if (end === 'timeout') {
      [...page.timeouts.values()][0].callback();
      assert.equal(page.api.action().kind, 'start-timeout');
    } else
      assert.equal(page.api.launcher(), end);
    assert.equal(page.api.polling(), false);
    assert.equal(page.intervals.size, 0);
    assert.equal(mutations.length, 1);
  }
  const wake = pageHarness(async path => path.endsWith('/wake') ? { sent: true } : { online: false });
  await wake.api.runWakeAction('office', 'wake');
  assert.equal([...wake.timeouts.values()][0].milliseconds, 90000);
  [...wake.timeouts.values()][0].callback();
  assert.equal(wake.api.action().kind, 'wake-timeout');
  assert.equal(wake.api.polling(), false);
});

test('actual invitation page warns before issuance, renders read-only text and copies exactly that text', async () => {
  const url = `http://127.0.0.1:9009/#autolauncher=${'a'.repeat(64)}`;
  let calls = 0;
  let issue!: (value: unknown) => void;
  const page = pageHarness(async () => { calls++; return new Promise(resolve => { issue = resolve; }); });
  page.api.renderPcCards();
  assert.equal(page.list.children[0].children[3].children.find(child => child.tag === 'p')?.textContent,
    'Pozvánku použijte přímo na počítači Local PC v domácí síti, ne přes VPN. Nová pozvánka zneplatní předchozí.');
  const first = page.api.runWakeAction('office', 'invitation');
  page.api.refresh();
  assert.ok(page.buttons().every(button => button.disabled));
  await page.api.runWakeAction('office', 'invitation');
  assert.equal(calls, 1);
  issue({ invitationUrl: url, expiresInSeconds: 300 });
  await first;
  const panel = page.list.children[0].children.find(child => child.tag === 'section')!;
  const field = panel.children.find(child => child.tag === 'textarea')!;
  assert.equal(field.value === url, true);
  assert.equal(field.readOnly, true);
  assert.equal(panel.children.some(child => child.tag === 'a'), false);
  const copy = panel.children.find(child => child.tag === 'button')!;
  await copy.onclick!();
  assert.equal(page.copied[0] === field.value, true);
  assert.equal(panel.children.some(child => child.textContent === 'Platí ještě 5:00'), true);
  assert.equal(panel.children.some(child => child.textContent === 'Po obnovení stránky pozvánka zmizí.'), true);
});

test('actual page redirects on 401 without retrying a mutation or keeping its poll', async () => {
  const calls: string[] = [];
  const page = pageHarness(async path => { calls.push(path); return { loginUrl: '/login' }; }, 401);
  await page.api.runWakeAction('office', 'start');
  await page.api.runWakeAction('office', 'start');
  assert.deepEqual(page.redirects, ['/login']);
  assert.deepEqual(calls, ['/api/wake-service/office/start']);
  assert.equal(page.intervals.size, 0);
  assert.equal(page.api.polling(), false);
});

test('accepted wake follows every launcher state until peer connection and automatically selects the PC', async () => {
  let online = false;
  let state = 'unavailable';
  let mutations = 0;
  const page = pageHarness(async (path, options) => {
    if (options?.method === 'POST') { mutations++; return { sent: true }; }
    return path.startsWith('/pc-status') ? { online, href: '/computer.html?pc=office' } : { state };
  });
  await page.api.runWakeAction('office', 'wake');
  const poll = [...page.intervals.values()][0];
  const deadline = [...page.timeouts.keys()][0];
  assert.equal(page.timeouts.get(deadline)!.milliseconds, 90000);
  for (state of ['unavailable', 'stopped', 'starting', 'failed', 'ready']) {
    await poll.callback();
    assert.equal(page.api.launcher(), state);
    assert.equal(page.api.polling(), true);
    assert.equal(page.api.action().kind, 'waking');
    assert.equal(page.timeouts.has(deadline), true);
    assert.equal(page.navigations.length, 0);
  }
  online = true;
  await poll.callback();
  assert.equal(page.api.polling(), false);
  assert.equal(page.intervals.size, 0);
  assert.equal(page.timeouts.has(deadline), false);
  const selection = [...page.timeouts.values()].find(timer => timer.milliseconds === 500)!;
  selection.callback();
  assert.deepEqual(page.navigations, ['/computer.html?pc=office']);
  assert.equal(mutations, 1);
});

test('wake still expires at 90 seconds when its launcher answers but the peer never connects', async () => {
  const page = pageHarness(async path => path.endsWith('/wake') ? { sent: true }
    : path.startsWith('/pc-status') ? { online: false } : { state: 'ready' });
  await page.api.runWakeAction('office', 'wake');
  await [...page.intervals.values()][0].callback();
  assert.equal(page.api.polling(), true);
  const deadline = [...page.timeouts.values()][0];
  assert.equal(deadline.milliseconds, 90000);
  deadline.callback();
  assert.equal(page.api.polling(), false);
  assert.equal(page.api.action().kind, 'wake-timeout');
  assert.equal(page.api.launcher(), 'ready');
  assert.equal(page.navigations.length, 0);
});

test('older service and launcher refreshes cannot replace a newer healthy state', async () => {
  const serviceReplies: ((result: unknown) => void)[] = [];
  const launcherReplies: ((result: unknown) => void)[] = [];
  const page = pageHarness(async path => new Promise(resolve => {
    if (path === '/wake-service') serviceReplies.push(resolve);
    else launcherReplies.push(resolve);
  }));
  const olderService = page.api.refreshWakeService();
  const newerService = page.api.refreshWakeService();
  serviceReplies[1]({ state: 'ready', version: '2.0.1', computers: [{ id: 'office', hasLauncher: true }] });
  await newerService;
  launcherReplies[0]({ state: 'stopped' });
  await Promise.resolve();
  serviceReplies[0]({ state: 'unreachable' });
  await olderService;
  assert.equal(page.api.service().state, 'ready');
  assert.equal(page.footer.textContent, 'Služba probouzení 2.0.1');
  assert.deepEqual(page.buttons().map(button => button.textContent), ['Probudit', 'Spustit Jamat', 'Nastavit spouštění Jamatu']);
  assert.equal(launcherReplies.length, 1);
  const olderLauncher = page.api.refreshLauncher('office');
  const newerLauncher = page.api.refreshLauncher('office');
  launcherReplies[2]({ state: 'ready' });
  await newerLauncher;
  launcherReplies[1]({ problem: 'unreachable' });
  await olderLauncher;
  assert.equal(page.api.launcher(), 'ready');
  assert.equal(page.api.readProblem(), undefined);
  assert.equal(page.list.children[0].children[2].textContent, 'Jamat je připravený.');
});

test('launcher read recovery clears only the read problem and preserves wake progress and mutation errors', async () => {
  let readFailure = true;
  let mutationFailure = false;
  const page = pageHarness(async (path, options) => {
    if (options?.method === 'POST') return mutationFailure ? { problem: 'rate-limited', retryAfter: 3 } : { sent: true };
    return path.startsWith('/pc-status') ? { online: false }
      : readFailure ? { problem: 'unreachable' } : { state: 'starting' };
  });
  await page.api.runWakeAction('office', 'wake');
  const poll = [...page.intervals.values()][0];
  await poll.callback();
  assert.equal(page.api.readProblem()?.problem, 'unreachable');
  assert.equal(page.api.action().kind, 'waking');
  assert.equal(page.list.children[0].children[4].textContent, 'Paket odeslán. Probuzení zatím není ověřené.');
  assert.equal(page.list.children[0].children[5].textContent, 'Služba probouzení není dostupná.');
  readFailure = false;
  await page.api.refreshLauncher('office');
  assert.equal(page.api.readProblem(), undefined);
  assert.equal(page.api.action().kind, 'waking');
  assert.equal(page.list.children[0].children.length, 5);
  mutationFailure = true;
  await page.api.runWakeAction('office', 'wake');
  readFailure = true;
  await page.api.refreshLauncher('office');
  assert.equal(page.api.readProblem()?.problem, 'unreachable');
  readFailure = false;
  await poll.callback();
  assert.equal(page.api.readProblem(), undefined);
  assert.equal(page.api.action().problem, 'rate-limited');
  assert.equal(page.api.polling(), true);
  assert.equal(page.list.children[0].children[4].textContent, 'Příliš mnoho požadavků, zkuste to za 3 s.');
  assert.equal(page.list.children[0].children.length, 5);
});

test('rejected repeat actions preserve the accepted wake poll and its original deadline', async () => {
  for (const repeat of ['wake', 'start']) {
    let online = false;
    let posts = 0;
    let rejectRepeat!: (result: unknown) => void;
    const page = pageHarness(async (path, options) => {
      if (options?.method === 'POST') {
        if (++posts === 1) return { sent: true };
        return new Promise(resolve => { rejectRepeat = resolve; });
      }
      return path.startsWith('/pc-status') ? { online, href: '/computer.html?pc=office' } : { state: 'starting' };
    });
    await page.api.runWakeAction('office', 'wake');
    const [pollId, poll] = [...page.intervals.entries()][0];
    const deadlineId = [...page.timeouts.keys()][0];
    const repeated = page.api.runWakeAction('office', repeat);
    assert.equal(page.api.polling(), true);
    await page.api.runWakeAction('office', repeat);
    assert.equal(posts, 2);
    rejectRepeat({ problem: 'rate-limited', retryAfter: 3 });
    await repeated;
    assert.equal(page.intervals.get(pollId), poll);
    assert.equal(page.timeouts.has(deadlineId), true);
    await poll.callback();
    assert.equal(page.api.polling(), true);
    assert.equal(page.api.action().problem, 'rate-limited');
    online = true;
    await poll.callback();
    assert.equal(page.api.polling(), false);
    [...page.timeouts.values()].find(timer => timer.milliseconds === 500)!.callback();
    assert.deepEqual(page.navigations, ['/computer.html?pc=office']);
    assert.equal(posts, 2);
  }
});

test('a launcher read begun during a mutation cannot overwrite its accepted starting result', async () => {
  let accept!: (result: unknown) => void;
  let finishRead!: (result: unknown) => void;
  const page = pageHarness(async (_path, options) => new Promise(resolve => {
    if (options?.method === 'POST') accept = resolve;
    else finishRead = resolve;
  }));
  const start = page.api.runWakeAction('office', 'start');
  const staleRead = page.api.refreshLauncher('office');
  accept({ state: 'starting' });
  await start;
  finishRead({ state: 'stopped' });
  await staleRead;
  assert.equal(page.api.launcher(), 'starting');
  assert.equal(page.api.action().kind, 'starting');
  assert.equal(page.api.polling(), true);
});
