import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { RelayConfig } from './appConfig.js';
import { AppContext } from './appContext.js';
import { AppHub } from './appHub.js';
import { json } from './http.js';
import releasePackage from '../package.json';

export class App {
  readonly server: http.Server;
  private readonly config: RelayConfig;
  private readonly context: AppContext;
  private readonly hub: AppHub;

  constructor(config: RelayConfig, context: AppContext, hub = new AppHub(config, context)) {
    this.config = config;
    this.context = context;
    this.hub = hub;
    this.server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent)
          json(res, { error: 'Request failed' }, 500);
        else
          res.destroy();
      });
    });
    this.server.on('close', () => this.hub.relay.close());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'same-origin');
    const rawPath = (req.url ?? '').split('?', 1)[0];
    if (rawPath === '/api/system/health') {
      if (req.method === 'GET' || req.method === 'HEAD')
        json(res, { status: 'ok' });
      else {
        res.setHeader('Allow', 'GET, HEAD');
        json(res, { error: 'Method not allowed' }, 405);
      }
      return;
    }
    const url = new URL(req.url ?? '/', this.config.origin);
    if (req.headers.host !== new URL(this.config.origin).host || url.origin !== this.config.origin) {
      json(res, { error: 'Unexpected host' }, 400);
      return;
    }
    if (!await this.hub.login.authorize(req, res, url))
      return;
    if (req.method === 'GET' && (url.pathname === '/relay/version' || url.pathname === '/api/system/version')) {
      json(res, { version: releasePackage.version, buildTime: this.config.buildTime });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await this.hub.relay.handle(req, res, url);
      return;
    }
    const file = url.pathname === '/' || url.pathname === '/index.html' ? 'index.html' : ['/shared.js', '/computer.html', '/computer.js', '/computer.css'].includes(url.pathname) ? url.pathname.slice(1) : undefined;
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8' });
      res.end(await readFile(new URL(file, this.context.webDirectory)));
      return;
    }
    json(res, { error: 'Not found' }, 404);
  }
}
