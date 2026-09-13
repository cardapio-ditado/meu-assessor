-- 02-grants.sql — privilegio minimo. Roda DEPOIS das migracoes 0001..0006.
--
-- O papel da aplicacao le e escreve o conteudo do schema `ma` e nada fora
-- dele: sem DDL, sem acesso ao schema de outro produto, sem poder alterar
-- politicas de RLS.
set search_path to ma, public, extensions;

-- Controle de migracoes no schema do produto. Em banco compartilhado,
-- public.schema_migrations colidiria com o controle do vizinho.
create table if not exists ma.schema_migrations (
  filename text primary key,
  content_hash text not null,
  applied_at timestamptz not null default now()
);

grant usage on schema ma to meu_assessor_app;

-- `extensions` existe em Postgres gerenciado; em Postgres proprio nao, e o
-- grant seria erro. Por isso condicional.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    grant usage on schema extensions to meu_assessor_app;
  end if;
end $$;

grant select, insert, update, delete on all tables in schema ma to meu_assessor_app;
grant usage, select on all sequences in schema ma to meu_assessor_app;
grant execute on all functions in schema ma to meu_assessor_app;

-- Tabelas de migracoes futuras herdam o mesmo privilegio.
alter default privileges in schema ma
  grant select, insert, update, delete on tables to meu_assessor_app;
alter default privileges in schema ma
  grant usage, select on sequences to meu_assessor_app;

-- DDL e so por migracao.
revoke create on schema ma from meu_assessor_app;

-- A aplicacao nunca deve alcancar o schema de outro produto. Observacao: o
-- provedor costuma conceder USAGE em `public` ao pseudo-papel PUBLIC, e
-- revogar de PUBLIC afetaria os outros sistemas do banco. USAGE de schema NAO
-- concede leitura de tabela; `04-verify.sql` confirma isso tabela por tabela.
revoke all on schema public from meu_assessor_app;
