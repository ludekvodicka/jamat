import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PcEndpoint, PcStatus } from './pcEndpoint.js';
import type { PcConfig } from './appConfig.js';
import { json } from './http.js';

export class PcRelay {
  private readonly pcs: PcConfig[];
  private readonly endpoints: ReadonlyMap<string, PcEndpoint>;

  constructor(pcs: PcConfig[], endpoints: ReadonlyMap<string, PcEndpoint>) {
    this.pcs = pcs;
    this.endpoints = endpoints;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/api/pcs') {
      json(res, { pcs: this.pcs.map(({ id, label }) => ({ id, label })) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pcs/status') {
      json(res, { pcs: await Promise.all(this.pcs.map(async pc => ({ id: pc.id, label: pc.label, ...await this.status(pc) }))) });
      return;
    }
    const match = url.pathname.match(/^\/api\/pc\/([^/]+)(\/.*)?$/);
    const id = match?.[1] ?? url.searchParams.get('pc');
    const pc = id ? this.pcs.find(candidate => candidate.id === id) : this.pcs[0];
    if (!pc) {
      json(res, { error: 'PC not configured' }, 404);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pc-status') {
      json(res, { pc: pc.id, ...await this.status(pc) });
      return;
    }
    if (url.pathname === '/api/wol') {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    await this.endpoints.get(pc.id)!.handle(req, res, `${match ? '/api' + (match[2] ?? '/') : url.pathname}${url.search}`);
  }

  close(): void {
    for (const endpoint of this.endpoints.values())
      endpoint.close();
  }

  private status(pc: PcConfig): Promise<PcStatus> {
    return this.endpoints.get(pc.id)!.status();
  }
}
