import { SessionLauncher } from './sessionLauncher.js';
import { ComputerTree } from './computerTree.ts';
import { ComputerExpansion, ComputerNavigation } from './computerNavigation.ts';
import { TerminalPreview } from './terminalPreview.ts';

const pcId = new URLSearchParams(location.search).get('pc');
const get = id => document.getElementById(id);
const navigation = new ComputerNavigation();
const terminalPreview = new TerminalPreview(get('content'));
let snapshot = null;
let expansion = null;
let returningScroll = 0;
let previewStamp = '';
let refreshing = null;

async function read(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    navigation.close();
    snapshot = null;
    get('sessions').replaceChildren();
    terminalPreview.clear();
    location.assign('/login');
    throw new Error('Přihlaste se znovu.');
  }
  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new Error(data.error || 'Počítač neodpovídá.');
    error.uncertain = data.uncertain;
    throw error;
  }
  return data;
}

const api = (path, options) => read(`/api/pc/${encodeURIComponent(pcId)}/${path}`, options);

function refresh() {
  refreshing ??= refreshSnapshot().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshSnapshot() {
  get('refresh').disabled = true;
  get('sessions').setAttribute('aria-busy', 'true');
  get('status').textContent = 'Načítám sessions…';
  navigation.invalidate();
  try {
    const [status, next] = await Promise.all([api('status'), api('sessions')]);
    ComputerTree.build(next, '', 'all');
    snapshot = next;
    const selection = navigation.reconcile(snapshot.sessions);
    get('status').textContent = `Jamat ${status.identity.applicationVersion} online · ${snapshot.sessions.filter(s => s.life === 'live' || s.life === 'starting').length} běžících sessions · načteno ${new Date().toLocaleTimeString()}`;
    get('groups-status').textContent = snapshot.sessionGroups === undefined
      ? 'Tato verze Jamatu neposílá názvy a pořadí skupin. Zobrazuji kategorie a projekty; pro skupiny aktualizujte desktop.' : '';
    render();
    if (selection === 'retained') {
      previewControls();
      await preview(navigation.previewKind);
    } else if (selection === 'missing') {
      terminalPreview.clear();
      get('preview-status').textContent = 'Vybraná session už není dostupná ve vzdáleném seznamu.';
      previewControls();
    } else if (selection !== 'none')
      throw new Error('Neznámý stav výběru.');
  } catch (error) {
    get('status').textContent = `${error.message}${snapshot ? ' Zobrazený seznam je z posledního úspěšného načtení.' : ''}`;
    if (!get('preview').hidden)
      get('preview-status').textContent = 'Data se nepodařilo obnovit. Náhled nemusí být aktuální.';
  } finally {
    get('refresh').disabled = false;
    get('sessions').setAttribute('aria-busy', 'false');
  }
}

function render() {
  if (!snapshot || !expansion) return;
  const host = get('sessions');
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const top = host.scrollTop;
  const query = get('search').value;
  const nodes = ComputerTree.build(snapshot, query, get('filter').value);
  let id = 0;
  function list(items) {
    const ul = document.createElement('ul');
    for (const node of items) {
      const li = document.createElement('li');
      li.className = `tree-${node.kind}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = node.key;
      const label = document.createElement('span');
      label.className = 'row-title';
      if (node.kind === 'session') {
        const session = node.session;
        button.className = 'session';
        button.dataset.color = session.color ?? 'none';
        button.setAttribute('aria-pressed', String(navigation.selected?.sessionId === session.sessionId));
        label.textContent = session.title;
        button.title = session.tabTitle;
        const detail = document.createElement('small');
        detail.textContent = `${session.agent?.agentId || 'Terminal'} · ${ComputerTree.status(session)}`;
        button.append(label, detail);
        button.addEventListener('click', () => openSession(session));
        li.append(button);
        if (node.children.length) li.append(list(node.children));
      } else if (node.kind === 'group' || node.kind === 'category' || node.kind === 'project') {
        const expanded = expansion.expanded(node.collapseKey, node.kind, query.trim() !== '');
        button.className = 'branch';
        button.setAttribute('aria-expanded', String(expanded));
        const childId = `branch-${++id}`;
        button.setAttribute('aria-controls', childId);
        label.textContent = node.label;
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(node.count);
        count.setAttribute('aria-label', `${node.count} sessions`);
        button.append(label, count);
        button.disabled = query.trim() !== '';
        const toggle = value => {
          if (!expansion.set(node.collapseKey, value))
            get('preferences-status').textContent = 'Prohlížeč neumožňuje uložit rozbalení. Platí jen pro tuto stránku.';
          render();
        };
        button.addEventListener('click', () => toggle(!expanded));
        button.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight' && !expanded) { event.preventDefault(); toggle(true); }
          else if (event.key === 'ArrowLeft' && expanded) { event.preventDefault(); toggle(false); }
        });
        const children = list(node.children);
        children.id = childId;
        children.hidden = !expanded;
        li.append(button, children);
      } else
        throw new Error('Neznámý druh řádku.');
      ul.append(li);
    }
    return ul;
  }
  host.replaceChildren(list(nodes));
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = snapshot.sessions.length ? 'Žádné sessions pro tento filtr.' : 'Počítač nemá dostupné sessions.';
    host.append(empty);
  }
  host.scrollTop = top;
  if (focused)
    [...host.querySelectorAll('button')].find(button => button.dataset.key === focused)?.focus({ preventScroll: true });
}

function openSession(session) {
  returningScroll = window.scrollY;
  navigation.select(session);
  get('session-title').textContent = session.tabTitle;
  get('preview').hidden = false;
  document.body.dataset.view = 'detail';
  previewControls();
  render();
  if (matchMedia('(max-width:720px)').matches) {
    window.scrollTo(0, 0);
    get('close-preview').focus({ preventScroll: true });
  }
  void preview(navigation.previewKind);
}

function previewControls() {
  const session = navigation.selected;
  if (session) get('session-title').textContent = session.tabTitle;
  get('terminal').disabled = !session || session.life !== 'live';
  get('transcript').disabled = !session;
  get('terminal').setAttribute('aria-pressed', String(navigation.previewKind === 'terminal'));
  get('transcript').setAttribute('aria-pressed', String(navigation.previewKind === 'transcript'));
}

async function preview(kind) {
  const session = navigation.selected;
  if (!session) return;
  const sequence = navigation.begin(kind);
  previewControls();
  const stamp = `${session.sessionId}/${kind}`;
  const scroll = stamp === previewStamp ? get('content').scrollTop : 0;
  const scrollLeft = stamp === previewStamp ? get('content').scrollLeft : 0;
  previewStamp = stamp;
  terminalPreview.clear();
  if (kind === 'terminal' && session.life !== 'live') {
    get('preview-status').textContent = 'Tato session už nemá běžící terminál. Otevřete konverzaci.';
    return;
  }
  get('preview-status').textContent = 'Načítám náhled…';
  try {
    const data = await api(`${kind}?sessionId=${encodeURIComponent(session.sessionId)}`);
    if (!navigation.accepts(sequence)) return;
    if (kind === 'terminal') {
      terminalPreview.show(data.snapshot.projection, () => {
        if (!navigation.accepts(sequence)) return;
        get('content').scrollTop = scroll;
        get('content').scrollLeft = scrollLeft;
      });
      get('preview-status').textContent = data.snapshot.projection.screenTruncated ? 'Aktuální obrazovka, zkrácený náhled.' : 'Aktuální obrazovka terminálu.';
    } else if (kind === 'transcript') {
      const reading = data.reading;
      if (reading.kind === 'messages') {
        const transcript = document.createElement('pre');
        transcript.textContent = reading.messages.map(message => `${message.role === 'user' ? 'Vy' : 'Asistent'}${message.at ? ` · ${new Date(message.at).toLocaleString()}` : ''}\n${message.text}${message.textTruncated ? '\n[Zpráva zkrácena]' : ''}`).join('\n\n');
        get('content').append(transcript);
        get('preview-status').textContent = reading.earlierContentOmitted ? 'Poslední zprávy, starší část není v náhledu.' : 'Náhled konverzace.';
      } else if (reading.kind === 'none')
        get('preview-status').textContent = reading.reason;
      else
        throw new Error('Neznámý formát konverzace.');
    } else
      throw new Error('Neznámý náhled.');
    get('content').scrollTop = scroll;
  } catch (error) {
    if (navigation.accepts(sequence)) get('preview-status').textContent = error.message;
  }
}

get('refresh').addEventListener('click', refresh);
get('search').addEventListener('input', render);
get('filter').addEventListener('change', render);
get('terminal').addEventListener('click', () => preview('terminal'));
get('transcript').addEventListener('click', () => preview('transcript'));
get('close-preview').addEventListener('click', () => {
  const selected = navigation.selected?.sessionId;
  navigation.close();
  get('preview').hidden = true;
  terminalPreview.clear();
  document.body.dataset.view = 'list';
  render();
  window.scrollTo(0, returningScroll);
  [...get('sessions').querySelectorAll('button')].find(button => button.dataset.key === `session:${selected}`)?.focus({ preventScroll: true });
});

async function initialize() {
  if (!pcId || !/^[\w-]+$/.test(pcId)) {
    get('status').textContent = 'Vyberte počítač na úvodní stránce.';
    return;
  }
  try {
    const [auth, pcs] = await Promise.all([read('/api/auth/session'), read('/api/pcs')]);
    let storage = null;
    try { storage = window.localStorage; } catch { /* Storage can be disabled by the browser. */ }
    expansion = new ComputerExpansion(storage, auth.user, pcId);
    new SessionLauncher(api, async sessionId => {
      await refresh();
      if (!snapshot?.sessions.some(session => session.sessionId === sessionId)) await refresh();
      const session = snapshot?.sessions.find(session => session.sessionId === sessionId);
      if (!session) throw new Error('Session není v seznamu.');
      openSession(session);
    }, () => navigation.selected?.project, storage, auth.user, pcId);
    get('account').textContent = auth.user;
    get('computer-name').textContent = pcs.pcs?.find(pc => pc.id === pcId)?.label || 'Jamat';
    await refresh();
  } catch (error) {
    get('status').textContent = error.message;
  }
}
void initialize();
