/**
 * Servidor local. Abre porta e delega para o mesmo handler que a funcao
 * serverless usa, para que o comportamento nao divirja entre os ambientes.
 *
 * Uso: DATABASE_URL=... SESSION_SECRET=... DEMO_PASSWORD=... npm run api
 */
import { createServer } from 'node:http';
import { closePool } from '../../../packages/db/src/pool.ts';
import { configWarnings, handle } from './app.ts';

const port = Number(process.env['API_PORT'] ?? 8787);

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(port, () => {
  console.log(`Meu Assessor - API e app em http://localhost:${port}`);
  for (const warning of configWarnings()) console.warn(`AVISO: ${warning}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  });
}
