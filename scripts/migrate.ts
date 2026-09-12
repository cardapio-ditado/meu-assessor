/**
 * Runner de migracoes. Briefing 17.3: "O agente deve entregar migracoes [...]
 * e mecanismo de deploy reproduzivel."
 *
 * Cada arquivo roda dentro de UMA transacao e e registrado com o hash do
 * conteudo. Falha parcial nao deixa esquema meio aplicado; arquivo alterado
 * depois de aplicado e erro, nao aplicacao silenciosa.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('DATABASE_URL nao definida. Copie .env.example e configure.');
  process.exit(2);
}

const reset = process.argv.includes('--reset');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  if (reset) {
    console.warn('--reset: derrubando o schema ma (apenas ambientes de desenvolvimento)');
    await client.query('drop schema if exists ma cascade');
  }

  // O controle vive no schema do proprio produto. Em um banco compartilhado
  // com outro sistema, criar `public.schema_migrations` poluiria o schema do
  // vizinho e colidiria com o controle dele.
  await client.query('create schema if not exists ma');
  await client.query(`
    create table if not exists ma.schema_migrations (
      filename text primary key,
      content_hash text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map<string, string>(
    (await client.query<{ filename: string; content_hash: string }>(
      'select filename, content_hash from ma.schema_migrations',
    )).rows.map((r) => [r.filename, r.content_hash]),
  );

  let ran = 0;
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous !== undefined) {
      if (previous !== hash) {
        throw new Error(
          `${file} foi alterado depois de aplicado (hash ${previous.slice(0, 12)} -> ${hash.slice(0, 12)}). ` +
            'Crie uma nova migracao em vez de editar uma ja aplicada.',
        );
      }
      continue;
    }

    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into ma.schema_migrations (filename, content_hash) values ($1, $2)',
        [file, hash],
      );
      await client.query('commit');
      console.log(`aplicada  ${file}`);
      ran += 1;
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${file} falhou e foi revertida: ${(error as Error).message}`);
    }
  }

  console.log(ran === 0 ? 'nenhuma migracao pendente' : `${ran} migracao(oes) aplicada(s)`);
} finally {
  await client.end();
}
