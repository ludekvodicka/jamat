import type http from 'node:http'

export class HostHttpResponse {
  static json(response: http.ServerResponse, body: unknown, status = 200): void {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }
}
