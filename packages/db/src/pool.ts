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
  /**
   * Em execucao serverless cada instancia abre seu proprio pool, e centenas de
   * instancias esgotariam as conexoes do banco. Por isso: no maximo uma
   * conexao por instancia, tempo de ocio curto, e a URL apontando para o
   * pooler em modo transacao do provedor.
   *
   * `withContext` roda tudo dentro de uma transacao explicita com
   * set_config(..., is_local => true), que e exatamente o que o modo transacao
   * suporta — o contexto morre com a transacao e nao vaza para a proxima
   * requisicao que reusar a conexao do pooler.
   */
  const serverless = process.env['VERCEL'] === '1' || process.env['MA_SERVERLESS'] === '1';
  pool = new pg.Pool({
    connectionString,
    max: serverless ? 1 : Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    idleTimeoutMillis: serverless ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'meu-assessor',
    // O pooler do provedor termina TLS por conta propria e nem sempre
    // apresenta cadeia verificavel pelo cliente; a conexao continua cifrada.
    ...(process.env['DATABASE_SSL_NO_VERIFY'] === '1'
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
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
 * operacao da plataforma e pelas migracoes. Sob RLS, este caminho NAO le
 * conteudo de cliente — ha um teste que verifica exatamente isso.
 */
export async function withoutTenant<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Caminho de autenticacao. Grava apenas `ma.login` e nenhuma organizacao, o
 * que habilita as politicas `auth_path_*` da migracao 0006: a transacao le
 * exclusivamente as concessoes daquele login. Nao existe papel privilegiado
 * nem funcao SECURITY DEFINER envolvida.
 */
export async function withLogin<T>(
  login: string,
  fn: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['ma.login', login]);
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
