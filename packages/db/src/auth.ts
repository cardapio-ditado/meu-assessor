/**
 * Resolucao do contexto autorizado. Briefing 4.2: "A identidade do usuario vem
 * do mecanismo de autenticacao e do cadastro validado, nao do nome dito em um
 * audio. [...] O fato de alguem escrever 'sou a prefeita' nao concede qualquer
 * permissao."
 */
import type { AccessClass } from '../../domain/src/states.ts';
import type { AuthorizedContext, Role } from '../../domain/src/types.ts';
import { withLogin } from './pool.ts';

export class AuthorizationError extends Error {}

interface GrantRow {
  user_id: string;
  display_name: string;
  tenant_id: string;
  tenant_slug: string;
  role: string;
  access_classes: string[];
  municipality_id: string;
  municipality_name: string;
  time_zone: string;
}

/**
 * Resolve as organizacoes que o login pode acessar. Nao revela a existencia de
 * outras organizacoes (B.1: "GET /v1/me [...] nao revelar outras
 * organizacoes").
 */
export async function resolveContexts(login: string): Promise<AuthorizedContext[]> {
  // A tabela de concessoes tem RLS por organizacao e, no momento do login,
  // ainda nao existe organizacao. `withLogin` grava `ma.login` e nada mais, o
  // que habilita a politica `auth_path_own_grants` da migracao 0006: esta
  // transacao le exclusivamente as concessoes deste login. Sem papel
  // privilegiado e sem SECURITY DEFINER — o esquema roda em Postgres
  // gerenciado sem excecao de privilegio.
  const rows = await withLogin(login, async (db) => {
    const result = await db.query<GrantRow>(
      `select u.id as user_id, u.display_name,
              t.id as tenant_id, t.slug as tenant_slug,
              g.role, g.access_classes::text[] as access_classes,
              m.id as municipality_id, m.name as municipality_name, m.time_zone
         from ma.users u
         join ma.user_grants g on g.user_id = u.id and g.revoked_at is null
         join ma.tenants t on t.id = g.tenant_id
         join ma.tenant_municipalities tm on tm.tenant_id = t.id
         join ma.municipalities m on m.id = tm.municipality_id
        where u.login = $1 and u.disabled_at is null`,
      [login],
    );
    return result.rows;
  });

  const byTenant = new Map<string, AuthorizedContext>();
  for (const row of rows) {
    const existing = byTenant.get(row.tenant_id);
    const roles: Role[] = existing ? [...existing.roles, row.role as Role] : [row.role as Role];
    const classes = new Set<AccessClass>([
      ...(existing?.accessClasses ?? []),
      ...(row.access_classes as AccessClass[]),
    ]);
    classes.delete('blocked'); // classe 'blocked' nunca e legivel
    byTenant.set(row.tenant_id, {
      userId: row.user_id,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      municipalityId: row.municipality_id,
      municipalityName: row.municipality_name,
      timeZone: row.time_zone,
      roles,
      accessClasses: [...classes],
    });
  }
  return [...byTenant.values()];
}

/**
 * Seleciona a organizacao da requisicao. 7.2: nao exigir escolha quando existe
 * apenas uma autorizacao; 25.1: troca de contexto explicita quando ha mais.
 */
export async function contextFor(login: string, tenantSlug?: string): Promise<AuthorizedContext> {
  const contexts = await resolveContexts(login);
  if (contexts.length === 0) {
    // Nao distinguir "usuario inexistente" de "sem acesso" (7.2).
    throw new AuthorizationError('acesso nao disponivel para estas credenciais');
  }
  if (tenantSlug === undefined) {
    const only = contexts[0];
    if (contexts.length > 1 || only === undefined) {
      throw new AuthorizationError('mais de uma organizacao autorizada: escolha explicita necessaria');
    }
    return only;
  }
  const chosen = contexts.find((c) => c.tenantSlug === tenantSlug);
  if (chosen === undefined) {
    throw new AuthorizationError('acesso nao disponivel para estas credenciais');
  }
  return chosen;
}

/** Assinatura de acesso usada na chave de cache (16.3). */
export function accessSignature(context: AuthorizedContext): string {
  return [
    context.tenantId,
    context.municipalityId,
    [...context.roles].sort().join('+'),
    [...context.accessClasses].sort().join('+'),
  ].join('|');
}

export function hasRole(context: AuthorizedContext, ...roles: readonly Role[]): boolean {
  return roles.some((r) => context.roles.includes(r));
}
