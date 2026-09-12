-- 0006_authn_path.sql
-- Caminho de autenticacao PORTAVEL. Nenhum papel privilegiado, nenhuma funcao
-- SECURITY DEFINER, nenhum superusuario.
--
-- O problema: a autenticacao precisa ler ma.user_grants ANTES de existir um
-- contexto de organizacao, e essa tabela tem RLS por organizacao. Tirar o RLS
-- dela resolveria e abriria outro buraco: uma sessao de um gabinete leria os
-- acessos de outro.
--
-- A primeira versao desta migracao usava uma funcao SECURITY DEFINER de dona
-- com BYPASSRLS. Isso funciona em Postgres proprio e NAO funciona em Postgres
-- gerenciado: no Supabase, o papel `postgres` nao e superusuario e nao pode
-- conceder BYPASSRLS. Ver docs/decisions (D13).
--
-- A solucao adotada nao precisa de privilegio nenhum: uma politica adicional
-- que vale SOMENTE quando nao ha organizacao no contexto, e que devolve
-- exclusivamente as concessoes do login sendo autenticado. O servidor grava
-- `ma.login` na transacao do caminho de autenticacao; e a mesma confianca que
-- ele ja tem para gravar `ma.tenant_id`, com escopo muito menor.
--
-- Consequencia importante: uma sessao com organizacao definida NUNCA cai nesta
-- politica, porque ma.current_tenant() nao e nulo la. O isolamento entre
-- organizacoes continua provado pelos testes em tests/security/.
-- `extensions` no caminho porque em Postgres gerenciado (Supabase) as
-- extensoes vivem nesse schema: sem ele, gen_random_uuid() e digest() nao
-- resolvem. Um schema inexistente no search_path e ignorado, entao a linha
-- e inofensiva em Postgres proprio.
set search_path to ma, public, extensions;

create or replace function ma.current_login() returns text
language sql stable as $$
  select nullif(current_setting('ma.login', true), '')
$$;

-- Concessoes do proprio login, apenas no caminho de autenticacao.
drop policy if exists auth_path_own_grants on ma.user_grants;
create policy auth_path_own_grants on ma.user_grants
  for select
  using (
    ma.current_tenant() is null
    and ma.current_login() is not null
    and exists (
      select 1
        from ma.users u
       where u.id = ma.user_grants.user_id
         and u.login = ma.current_login()
         and u.disabled_at is null
    )
  );

-- O caminho de autenticacao tambem precisa resolver qual municipio cada
-- organizacao autorizada cobre.
drop policy if exists auth_path_read on ma.tenant_municipalities;
create policy auth_path_read on ma.tenant_municipalities
  for select
  using (
    ma.current_tenant() is null
    and ma.current_login() is not null
    and exists (
      select 1
        from ma.user_grants g
        join ma.users u on u.id = g.user_id
       where g.tenant_id = ma.tenant_municipalities.tenant_id
         and u.login = ma.current_login()
         and u.disabled_at is null
         and g.revoked_at is null
    )
  );

-- Sessoes persistentes. Em execucao serverless nao existe processo longo para
-- guardar sessao em memoria: cada requisicao pode cair em outra instancia.
-- O cookie carrega um identificador opaco assinado; o estado vive aqui.
create table ma.sessions (
  id uuid primary key default gen_random_uuid(),
  user_login text not null,
  tenant_slug text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent_digest text,
  revoked_at timestamptz
);

create index on ma.sessions (expires_at);
create index on ma.sessions (user_login);

-- A tabela de sessoes e consultada antes de existir contexto de organizacao,
-- pelo mesmo motivo que ma.users: e ela que estabelece o contexto. O acesso e
-- por identificador opaco e imprevisivel, e a aplicacao nunca a expoe.
-- Nao ha RLS por organizacao aqui; ha expiracao e revogacao.
