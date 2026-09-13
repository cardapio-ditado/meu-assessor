-- 04-verify.sql — prova do isolamento, ASSUMINDO o papel da aplicacao.
--
-- Briefing 20.3 / F17: "Usar papel de aplicacao sem privilegios de bypass e
-- TESTAR as politicas, em vez de presumir que ativar RLS resolve todo o
-- isolamento."
--
-- Verificar como administrador nao prova nada: o administrador ve tudo. Por
-- isso o `set role`. Leia a coluna `esperado`: qualquer divergencia e
-- incidente de configuracao, nao detalhe.
set role meu_assessor_app;

select * from (
  select 1 as ord, 'papel efetivo' as verificacao,
         current_user::text as obtido, 'meu_assessor_app' as esperado
  union all select 2, 'papel contorna RLS',
         (select rolbypassrls::text from pg_roles where rolname = current_user), 'false'
  union all select 3, 'papel e superusuario',
         (select rolsuper::text from pg_roles where rolname = current_user), 'false'
  union all select 4, 'tabelas com RLS forcado no schema ma',
         (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'ma' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity),
         '24'
  union all select 5, 'funcoes SECURITY DEFINER no schema ma',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'ma' and p.prosecdef), '0'
  union all select 6, 'pode criar objeto no schema ma',
         has_schema_privilege(current_user, 'ma', 'create')::text, 'false'
  -- Sem contexto de organizacao nao se le conteudo. Este e o teste que falha
  -- se alguem conceder BYPASSRLS ao papel depois.
  union all select 7, 'sem contexto: afirmacoes visiveis',
         (select count(*)::text from ma.claims), '0'
  union all select 8, 'sem contexto: documentos visiveis',
         (select count(*)::text from ma.document_versions), '0'
  union all select 9, 'sem contexto: fontes visiveis',
         (select count(*)::text from ma.sources), '0'
  union all select 10, 'sem contexto: concessoes visiveis',
         (select count(*)::text from ma.user_grants), '0'
  -- Em banco compartilhado: o papel nao le tabela de outro produto. USAGE de
  -- schema costuma aparecer concedido (o provedor concede a PUBLIC) e NAO
  -- concede leitura de tabela; o que importa e a contagem abaixo.
  union all select 11, 'tabelas de outros schemas que o papel consegue ler',
         (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname not in ('ma','pg_catalog','information_schema')
             and n.nspname not like 'pg_%' and c.relkind = 'r'
             and has_table_privilege(current_user, c.oid, 'select')), '0'
  -- Fontes habilitadas: zero ate o checklist F.1 ser cumprido.
  union all select 12, 'fontes habilitadas (exige contexto, logo invisivel aqui)',
         (select count(*)::text from ma.sources where enabled), '0'
) t order by ord;
