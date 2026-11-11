import { createApplication } from './application.mjs';
export { createApplication } from './application.mjs';
const port = Number(process.env.PORT || 8081);
const host = process.env.HOST || '127.0.0.1';
const application = createApplication();
application.server.listen(port, host, () => console.log(`Свои · общая база · http://${host}:${port}`));
application.pos.start();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void application.close().then(() => process.exit(0)); });
