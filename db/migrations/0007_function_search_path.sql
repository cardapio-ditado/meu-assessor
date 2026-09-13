-- 0007_function_search_path.sql
-- Fixa o search_path das tres funcoes de contexto.
--
-- O linter do provedor aponta `function_search_path_mutable` nelas. Nenhuma e
-- SECURITY DEFINER (a 04-verify prova que o schema tem zero), e o pg_catalog e
-- pesquisado primeiro quando nao aparece explicitamente no search_path, entao a
-- captura classica nao se aplica aqui. Mesmo assim elas sao avaliadas DENTRO
-- das politicas de RLS, com o search_path de quem chama: sao o pior lugar do
-- esquema para depender de um caminho que outra pessoa controla.
--
-- Fixar e barato e nao muda comportamento: as tres usam apenas construcoes do
-- pg_catalog. `ma` entra no caminho para que uma edicao futura que referencie
-- um tipo do schema continue resolvendo.
set search_path to ma, public, extensions;

alter function ma.current_tenant() set search_path = pg_catalog, ma;
alter function ma.current_access_classes() set search_path = pg_catalog, ma;
alter function ma.current_login() set search_path = pg_catalog, ma;
