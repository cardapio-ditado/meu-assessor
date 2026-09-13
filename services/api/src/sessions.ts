/**
 * Sessoes. Briefing 7.2 (acesso, expiracao, dispositivo perdido) e 17.3
 * (segredo nunca no codigo).
 *
 * Em execucao serverless nao existe processo longo: um Map em memoria perde a
 * sessao na proxima requisicao, que pode cair em outra instancia. Por isso o
 * estado vive em ma.sessions e o cookie carrega apenas um identificador opaco
 * ASSINADO com SESSION_SECRET — a assinatura impede que alguem force um
 * identificador; a expiracao e a revogacao vivem no banco, onde podem ser
 * retiradas de verdade.
 */
import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { withoutTenant } from '../../../packages/db/src/pool.ts';

export const SESSION_COOKIE = 'ma_session';
export const SESSION_TTL_HOURS = 8;

function secret(): string {
  const value = process.env['SESSION_SECRET'] ?? '';
  if (value.length < 32) {
    throw new Error('SESSION_SECRET ausente ou com menos de 32 caracteres');
  }
  return value;
}

export function hasSecret(): boolean {
  return (process.env['SESSION_SECRET'] ?? '').length >= 32;
}

function sign(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('base64url');
}

function token(id: string): string {
  return `${id}.${sign(id)}`;
}

/** Verifica a assinatura em tempo constante e devolve o id, ou null. */
export function unwrap(rawToken: string | undefined): string | null {
  if (rawToken === undefined) return null;
  const at = rawToken.lastIndexOf('.');
  if (at <= 0) return null;
  const id = rawToken.slice(0, at);
  const given = rawToken.slice(at + 1);
  let expected: string;
  try {
    expected = sign(id);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? id : null;
}

/** Digest do agente, para auditoria sem guardar a cadeia inteira. */
function agentDigest(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') return null;
  return createHash('sha256').update(userAgent).digest('hex').slice(0, 16);
}

export interface SessionRecord {
  readonly login: string;
  readonly tenantSlug: string;
}

export async function create(
  login: string,
  tenantSlug: string,
  userAgent: string | undefined,
  secure: boolean,
): Promise<{ readonly cookie: string; readonly maxAgeSeconds: number }> {
  const id = randomUUID();
  await withoutTenant(async (db) => {
    await db.query(
      `insert into ma.sessions (id, user_login, tenant_slug, expires_at, user_agent_digest)
       values ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
      [id, login, tenantSlug, String(SESSION_TTL_HOURS), agentDigest(userAgent)],
    );
  });
  const maxAgeSeconds = SESSION_TTL_HOURS * 3600;
  const cookie =
    `${SESSION_COOKIE}=${token(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}` +
    (secure ? '; Secure' : '');
  return { cookie, maxAgeSeconds };
}

export async function resolve(rawToken: string | undefined): Promise<SessionRecord | null> {
  const id = unwrap(rawToken);
  if (id === null) return null;
  return withoutTenant(async (db) => {
    const r = await db.query<{ user_login: string; tenant_slug: string }>(
      `update ma.sessions
          set last_seen_at = now()
        where id = $1 and revoked_at is null and expires_at > now()
      returning user_login, tenant_slug`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : { login: row.user_login, tenantSlug: row.tenant_slug };
  });
}

export async function revoke(rawToken: string | undefined): Promise<void> {
  const id = unwrap(rawToken);
  if (id === null) return;
  await withoutTenant(async (db) => {
    await db.query(`update ma.sessions set revoked_at = now() where id = $1`, [id]);
  });
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` + (secure ? '; Secure' : '');
}

/**
 * Remove sessoes expiradas. 20.5 pede classes de retencao definidas; aqui a
 * retencao e o proprio TTL, e a limpeza roda junto do login para nao exigir
 * um agendador que ainda nao existe.
 */
export async function purgeExpired(): Promise<void> {
  await withoutTenant(async (db) => {
    await db.query(`delete from ma.sessions where expires_at < now() - interval '7 days'`);
  });
}
