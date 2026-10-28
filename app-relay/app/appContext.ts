import { readFileSync } from 'node:fs';

export class AppContext {
  readonly webDirectory: URL;
  readonly loginTemplate: string;

  constructor(webDirectory: URL) {
    this.webDirectory = webDirectory;
    this.loginTemplate = readFileSync(new URL('login.html', webDirectory), 'utf8');
  }
}
