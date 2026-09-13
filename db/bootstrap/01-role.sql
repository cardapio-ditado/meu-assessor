-- 01-role.sql — papel da aplicacao. Roda ANTES das migracoes.
--
-- Briefing 20.3 / F17: o papel que a aplicacao usa NAO pode contornar RLS.
-- NOBYPASSRLS e o padrao do Postgres, mas e declarado aqui de proposito: quem
-- ler o bootstrap ve a intencao, e `04-verify.sql` falha se alguem mudar isso
-- depois.
--
-- Sem senha: ela e definida pelo operador, fora de repositorio (17.3).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'meu_assessor_app') then
    create role meu_assessor_app login nobypassrls nosuperuser nocreatedb nocreaterole;
  else
    alter role meu_assessor_app nobypassrls nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

-- Permite ao papel administrativo assumir o papel da aplicacao para VERIFICAR
-- o isolamento (04-verify.sql). Nao amplia poder: o administrativo ja e dono
-- das tabelas.
do $$
begin
  if exists (select 1 from pg_roles where rolname = current_user) then
    execute format('grant meu_assessor_app to %I', current_user);
  end if;
exception
  when others then
    raise notice 'nao foi possivel conceder o papel a %: verifique o isolamento por outro caminho', current_user;
end $$;
