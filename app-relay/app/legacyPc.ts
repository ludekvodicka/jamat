import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { PcConfig } from './appConfig.js';
import type { PcEndpoint, PcStatus } from './pcEndpoint.js';
import { json } from './http.js';

export class LegacyPc implements PcEndpoint {
  private readonly pc: PcConfig;

  constructor(pc: PcConfig) {
    this.pc = pc;
  }

  async status(): Promise<PcStatus> {
    try {
      const response = await fetch(`${this.base()}/api/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      const result = await response.json() as { ok?: boolean };
      const online = response.ok && result.ok === true;
      return { online, detail: online ? 'Online' : 'Agent nedostupný' };
    } catch {
      return { online: false, detail: 'Agent nedostupný' };
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const outgoing = http.request(this.base() + path, { method: req.method, timeout: 10000, headers: {
      'Content-Type': req.headers['content-type'] ?? 'application/json',
      ...(this.pc.token ? { Authorization: `Bearer ${this.pc.token}` } : {}),
    } }, incoming => {
      // Upstream cookies, challenges and redirects must not become relay authentication.
      res.writeHead(incoming.statusCode ?? 502, { 'Content-Type': incoming.headers['content-type'] ?? 'application/json' });
      incoming.pipe(res);
      incoming.on('error', () => res.destroy());
    });
    outgoing.on('error', () => {
      if (!res.headersSent)
        json(res, { error: 'PC agent unreachable' }, 502);
      else
        res.destroy();
    });
    outgoing.on('timeout', () => outgoing.destroy());
    req.on('aborted', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  close(): void {}

  private base(): string {
    return `http://${this.pc.ip}:${this.pc.agentPort}`;
  }
}
