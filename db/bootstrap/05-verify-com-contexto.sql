-- 05-verify-com-contexto.sql — o outro lado da prova.
--
-- O 04 mostra que sem contexto nada e legivel. Este mostra que COM contexto o
-- produto enxerga o que deve, e que o caminho de autenticacao nao abre
-- conteudo. Tambem confirma que nenhum dado sintetico entrou no ambiente.
set role meu_assessor_app;

-- Caminho de autenticacao: apenas o login, nenhuma organizacao.
select set_config('ma.login', 'admin.implantacao', false);

select 'autenticacao: concessoes do proprio login' as verificacao,
       count(*)::text as obtido, '3' as esperado from ma.user_grants
union all
select 'autenticacao: conteudo visivel', (select count(*)::text from ma.sources), '0';

-- Agora com organizacao no contexto.
select set_config('ma.login', '', false);
select set_config('ma.tenant_id', (select id::text from ma.tenants where slug = 'varzea-grande'), false);
select set_config('ma.access_classes', 'public,internal_authorized', false);

select * from (
  select 1 as ord, 'fontes cadastradas' as verificacao,
         (select count(*)::text from ma.sources) as obtido, '9' as esperado
  union all select 2, 'conjuntos de dados', (select count(*)::text from ma.source_datasets), '10'
  union all select 3, 'fontes habilitadas', (select count(*)::text from ma.sources where enabled), '0'
  union all select 4, 'fontes com conector verificado',
         (select count(*)::text from ma.sources where integration_status = 'connector_verified'), '0'
  -- Dado sintetico em ambiente de implantacao e incidente (1.2).
  union all select 5, 'documentos sinteticos',
         (select count(*)::text from ma.document_versions where is_synthetic), '0'
  union all select 6, 'afirmacoes sinteticas',
         (select count(*)::text from ma.claims where is_synthetic), '0'
  union all select 7, 'busca textual em portugues responde',
         (select case when to_tsvector('portuguese', 'quadra poliesportiva') @@
                            websearch_to_tsquery('portuguese', 'quadra')
                      then 'sim' else 'nao' end), 'sim'
  union all select 8, 'trigrama disponivel',
         (select case when similarity('quadra poliesportiva', 'quadra poliespotiva') > 0.5
                      then 'sim' else 'nao' end), 'sim'
) t order by ord;
