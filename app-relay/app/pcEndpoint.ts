import type { IncomingMessage, ServerResponse } from 'node:http';

export interface PcStatus {
  online: boolean;
  detail: string;
  href?: string;
}

export interface PcEndpoint {
  status(): Promise<PcStatus>;
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  close(): void;
}
