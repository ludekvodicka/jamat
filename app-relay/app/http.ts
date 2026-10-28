import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

export function sameOrigin(req: IncomingMessage, origin: string): boolean {
  const site = req.headers['sec-fetch-site'];
  return (!site || site === 'same-origin' || site === 'none') &&
    (!req.headers.origin || req.headers.origin === origin) &&
    (req.method === 'GET' || req.method === 'HEAD' || req.headers.origin === origin);
}

export async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
    throw new Error('Expected a form.');
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 8192)
      throw new Error('Form too large.');
  }
  return new URLSearchParams(body);
}

export async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new Error('Expected JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
