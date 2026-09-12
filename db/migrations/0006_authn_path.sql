-- 0006_authn_path.sql
-- O caminho de autenticacao precisa ler os grants ANTES de existir um contexto
-- de organizacao. Deixar ma.user_grants sem RLS resolveria o problema e abriria
-- outro: uma sessao de um gabinete leria os acessos de outro.
--
-- Solucao adotada, coerente com o briefing 20.3 ("usar papel de aplicacao sem
-- privilegios de bypass") e F17 (o dono e papeis privilegiados contornam
-- politicas): UMA unica funcao SECURITY DEFINER, de dona identificada, que
-- recebe um login e devolve somente os grants daquele login. O papel da
-- aplicacao continua NOBYPASSRLS e nao ganha leitura direta da tabela.
--
-- Superficie total da excecao: uma funcao, um parametro, colunas fixas.
set search_path to ma, public;

-- Papel exclusivo da autenticacao. Nao faz login; existe apenas para ser o
-- dono da funcao abaixo.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'meu_assessor_authn') then
    create role meu_assessor_authn nologin bypassrls;
  end if;
end $$;

grant usage on schema ma to meu_assessor_authn;
grant select on ma.users, ma.user_grants, ma.tenants,
               ma.tenant_municipalities, ma.municipalities to meu_assessor_authn;

create or replace function ma.resolve_login_grants(p_login text)
returns table (
  user_id uuid,
  display_name text,
  tenant_id uuid,
  tenant_slug text,
  role text,
  access_classes text[],
  municipality_id uuid,
  municipality_name text,
  time_zone text
)
language sql
security definer
-- search_path fixo: uma funcao SECURITY DEFINER com search_path do chamador
-- pode ser induzida a executar objetos plantados pelo chamador.
set search_path = ma, pg_catalog
stable
as $$
  select u.id, u.display_name,
         t.id, t.slug,
         g.role, g.access_classes::text[],
         m.id, m.name, m.time_zone
    from ma.users u
    join ma.user_grants g on g.user_id = u.id and g.revoked_at is null
    join ma.tenants t on t.id = g.tenant_id
    join ma.tenant_municipalities tm on tm.tenant_id = t.id
    join ma.municipalities m on m.id = tm.municipality_id
   where u.login = p_login
     and u.disabled_at is null
$$;

alter function ma.resolve_login_grants(text) owner to meu_assessor_authn;

-- Ninguem executa por padrao; so o papel da aplicacao.
revoke all on function ma.resolve_login_grants(text) from public;
grant execute on function ma.resolve_login_grants(text) to meu_assessor_app;
