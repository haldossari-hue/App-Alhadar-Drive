import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
app.log.info(`الهدار درايف يعمل على ${config.publicUrl}`);
console.log(`الهدار درايف يعمل على ${config.publicUrl}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
