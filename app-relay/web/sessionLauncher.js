import { PendingSessionLaunch, SessionLaunchModel } from './sessionLaunchModel.ts';

const get = id => document.getElementById(id);

export class SessionLauncher {
  api;
  created;
  selectedProject;
  pending;
  options = null;
  busy = false;

  constructor(api, created, selectedProject, storage, account, pcId) {
    this.api = api;
    this.created = created;
    this.selectedProject = selectedProject;
    this.pending = new PendingSessionLaunch(storage, account, pcId);
    get('new-session').disabled = false;
    get('new-session').addEventListener('click', () => this.open());
    get('launch-close').addEventListener('click', () => get('launch-dialog').close());
    get('launch-agent').addEventListener('change', () => this.models());
    get('launch-worktree').addEventListener('change', () => this.worktreeHint());
    get('launch-form').addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    get('launch-check').addEventListener('click', () => this.recover());
    get('launch-reset').addEventListener('click', () => {
      if (this.busy || !confirm('Výsledek předchozího spuštění není potvrzený. Nejdřív na cílovém PC ověřte, že session nevznikla. Uvolnit formulář pro nový požadavek?')) return;
      this.pending.clear();
      void this.open();
    });
    get('launch-dialog').addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    if (this.pending.read()) get('launch-notice').textContent = 'Předchozí spuštění čeká na ověření. Otevřete Nová session.';
  }

  async open() {
    if (!get('launch-dialog').open) get('launch-dialog').showModal();
    const pending = this.pending.read();
    if (pending) {
      this.controls();
      get('launch-status').textContent = `Ověřte výsledek spuštění „${pending.title}“. Požadavek nebude odeslán znovu.`;
      return;
    }
    this.busy = true;
    this.options = null;
    this.controls();
    get('launch-status').textContent = 'Načítám projekty a modely z PC…';
    try {
      this.options = await this.api('launch-options');
      const catalog = SessionLaunchModel.projects(this.options);
      const select = get('launch-project');
      const previous = this.selectedProject();
      select.replaceChildren(new Option('Vyberte projekt…', ''));
      for (const group of catalog.groups) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        for (const project of group.projects) {
          const option = new Option(project.name, JSON.stringify([group.id, project.path]));
          option.title = project.path;
          option.selected = previous?.kind === 'project' && previous.categoryId === group.id && previous.projectPath === project.path;
          optgroup.append(option);
        }
        select.append(optgroup);
      }
      this.models();
      this.worktreeHint();
      get('launch-catalog-status').textContent = catalog.warnings.join(' ');
      get('launch-status').textContent = !this.options.createAvailable ? 'Tento Jamat nepovoluje vytváření sessions.'
        : select.options.length === 1 ? 'Na PC nejsou dostupné projekty.' : '';
    } catch (error) {
      this.options = null;
      get('launch-status').textContent = error.message;
    } finally {
      this.busy = false;
      this.controls();
    }
  }

  models() {
    if (!this.options) return;
    get('launch-model').replaceChildren(...SessionLaunchModel.models(this.options, get('launch-agent').value)
      .map(model => new Option(model.label, model.id)));
    get('launch-model-status').textContent = this.options.agents === null
      ? 'Tato verze Jamatu nenabízí seznam modelů. Použije nastavení cílového PC.' : '';
  }

  worktreeHint() {
    get('launch-worktree-status').hidden = !get('launch-worktree').checked;
  }

  controls() {
    const pending = this.pending.read();
    get('launch-fields').disabled = this.busy || pending !== null || !this.options?.createAvailable;
    get('launch-submit').disabled = this.busy || pending !== null || !this.options?.createAvailable || get('launch-project').options.length < 2;
    get('launch-submit').hidden = pending !== null;
    get('launch-check').hidden = pending === null;
    get('launch-reset').hidden = pending === null;
    get('launch-check').disabled = this.busy;
    get('launch-reset').disabled = this.busy;
    get('launch-close').disabled = this.busy;
  }

  async submit() {
    if (this.busy || this.pending.read() || !get('launch-form').reportValidity()) return;
    const [categoryId, projectPath] = JSON.parse(get('launch-project').value);
    const input = { operationId: crypto.randomUUID(), categoryId, projectPath, title: get('launch-title').value.trim(),
      agentId: get('launch-agent').value, model: get('launch-model').value || null, worktree: get('launch-worktree').checked };
    this.pending.begin(input);
    this.busy = true;
    this.controls();
    get('launch-status').textContent = 'Vytvářím session…';
    try {
      const result = await this.api('sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      await this.finish(result.session);
    } catch (error) {
      if (error.uncertain === false) {
        this.pending.clear();
        get('launch-status').textContent = error.message;
      } else {
        get('launch-status').textContent = `${error.message} Ověřuji, zda session vznikla…`;
        await this.lookup();
      }
    } finally {
      this.busy = false;
      this.controls();
    }
  }

  async recover() {
    if (this.busy || !this.pending.read()) return;
    this.busy = true;
    this.controls();
    get('launch-status').textContent = 'Ověřuji spuštění…';
    try { await this.lookup(); }
    finally { this.busy = false; this.controls(); }
  }

  async lookup() {
    try {
      const snapshot = await this.api('sessions');
      const session = this.pending.find(snapshot.sessions);
      if (session) await this.finish(session);
      else get('launch-status').textContent = 'Session zatím není v seznamu. Ověřte výsledek za chvíli nebo přímo na PC. Další spuštění je pozastavené, aby nevznikla kopie.';
    } catch (error) {
      get('launch-status').textContent = `Výsledek spuštění není potvrzený. ${error.message} Po obnovení spojení použijte Ověřit spuštění.`;
    }
  }

  async finish(session) {
    this.pending.clear();
    get('launch-dialog').close();
    get('launch-notice').textContent = `Session „${session.tabTitle}“ je vytvořená.${session.worktree ? ' Worktree se připravuje; případné schválení příkazů najdete v desktopovém Jamatu.' : ''}`;
    get('launch-title').value = '';
    try { await this.created(session.sessionId); }
    catch { get('launch-notice').textContent += ' Seznam se nepodařilo obnovit. Použijte Obnovit.'; }
  }
}
