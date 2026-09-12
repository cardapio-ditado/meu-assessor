/**
 * Acesso ao banco. Briefing 15.2: "O filtro de acesso deve ser aplicado ANTES
 * da recuperacao de documentos e tambem na leitura de qualquer resultado."
 *
 * Aqui isso e estrutural: nao existe caminho de leitura sem um
 * AuthorizedContext, e o contexto e gravado em variaveis de sessao dentro da
 * MESMA transacao da consulta, com set_config(..., is_local => true). As
 * politicas de RLS do 0005 leem essas variaveis.
 */
import pg from 'pg';
import type { AuthorizedContext } from '../../domain/src/types.ts';

export interface QueryRunner {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool !== null) return pool;
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL nao definida');
  }
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    application_name: 'meu-assessor',
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

/**
 * Executa uma funcao dentro de uma transacao com o contexto autorizado
 * aplicado. O contexto vem do servidor; um tenant_id recebido do navegador
 * nunca chega aqui (B.2).
 */
export async function withContext<T>(
  context: AuthorizedContext,
  fn: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // is_local = true: o valor morre com a transacao, nao contamina a conexao
    // devolvida ao pool.
    await client.query('select set_config($1, $2, true)', ['ma.tenant_id', context.tenantId]);
    await client.query('select set_config($1, $2, true)', [
      'ma.access_classes',
      context.accessClasses.join(','),
    ]);
    await client.query('select set_config($1, $2, true)', ['ma.user_id', context.userId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Caminho sem contexto de organizacao: usado apenas pela autenticacao, pela
 * operacao da plataforma e pelas migracoes. Toda chamada e auditada por quem
 * a usa; nao ha leitura de conteudo de cliente por aqui.
 */
export async function withoutTenant<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
