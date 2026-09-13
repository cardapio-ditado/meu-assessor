/**
 * Handler exportado para a plataforma serverless. Fica aqui, e nao em api/,
 * para ser compilado junto do resto pelo `tsc` do projeto — o arquivo em
 * api/index.js apenas reexporta o resultado da compilacao.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configWarnings, handle } from './app.ts';

// Avisos de configuracao uma vez por instancia fria, no log da plataforma.
for (const warning of configWarnings()) console.warn(`AVISO: ${warning}`);

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handle(req, res);
}
