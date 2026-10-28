import { App } from './app/app.js';
import { AppConfig } from './app/appConfig.js';
import { AppContext } from './app/appContext.js';

const config = AppConfig.read(process.env);
const app = new App(config, new AppContext(new URL('./web/', import.meta.url)));
app.server.listen(config.port, () => console.log(`Jamat relay listening on port ${(app.server.address() as { port: number }).port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => app.server.close());
