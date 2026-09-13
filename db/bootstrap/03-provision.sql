-- 03-provision.sql — organizacao do piloto e catalogo de fontes.
--
-- ARQUIVO GERADO. Nao edite a mao: a fonte de verdade e
-- packages/connectors/src/catalog.ts. Para regerar:
--   node --experimental-strip-types scripts/gen-provision.ts > db/bootstrap/03-provision.sql
--
-- Deliberadamente SEM dado sintetico. Consequencia esperada e correta: a
-- aplicacao abre com feed vazio e o aviso de que nenhum conector esta em
-- operacao. Isso nao e falha de implantacao; e a unica coisa verdadeira que
-- ela pode dizer antes de a etapa E1 ser cumprida (14.2, 28.2).
--
-- Idempotente: aplicar duas vezes nao duplica nada.
set search_path to ma, public, extensions;

insert into ma.municipalities (name, uf, time_zone, primary_cnpj)
values ('Varzea Grande', 'MT', 'America/Cuiaba', '03.507.548/0001-10')
on conflict (name, uf) do update set time_zone = excluded.time_zone;

insert into ma.tenants (slug, display_name)
values ('varzea-grande', 'Prefeitura de Varzea Grande - piloto Meu Assessor')
on conflict (slug) do update set display_name = excluded.display_name;

-- UMA conta de implantacao. As contas dos usuarios do piloto sao criadas pelo
-- administrador municipal: o briefing 1.3 exige autorizacao antes de criar
-- contas em nome de terceiros.
insert into ma.users (login, display_name, job_title)
values ('admin.implantacao', 'Administracao da implantacao', 'Implantacao e curadoria')
on conflict (login) do update set display_name = excluded.display_name;

insert into ma.tenant_municipalities (tenant_id, municipality_id)
select t.id, mu.id
  from ma.tenants t, ma.municipalities mu
 where t.slug = 'varzea-grande' and mu.name = 'Varzea Grande' and mu.uf = 'MT'
on conflict do nothing;

insert into ma.user_grants (user_id, tenant_id, role, access_classes)
select u.id, t.id, r.role, array['public','internal_authorized']::ma.access_class[]
  from ma.users u, ma.tenants t,
       (values ('municipal_admin'), ('data_curator'), ('manager')) as r(role)
 where u.login = 'admin.implantacao' and t.slug = 'varzea-grande'
on conflict (user_id, tenant_id, role) do nothing;

-- Catalogo de fontes. NENHUMA habilitada (8.1, C.2): a situacao de integracao
-- diz a verdade — pagina localizada, acesso sondado ou bloqueado, nunca
-- conector verificado.
insert into ma.sources
  (tenant_id, code, official_name, domain, organ, sphere, record_types,
   access_method, requires_credentials, known_limitations, integration_status,
   operational_owner, connector_version, desired_frequency, access_class, enabled)
select t.id, x.code, x.official_name, x.domain, x.organ, x.sphere, x.record_types,
       x.access_method, x.requires_credentials, x.known_limitations, x.integration_status,
       'operacao-nao-designada', '0.1.0', 'duas janelas diarias', 'public', false
  from ma.tenants t,
  (values
      ('F01', 'Prefeitura Municipal de Varzea Grande', 'www.varzeagrande.mt.gov.br', 'Prefeitura Municipal de Varzea Grande', 'municipal', array['news','organization_chart']::text[], 'html', false, array['cobertura historica do arquivo de noticias nao medida','noticia oficial nao substitui registro administrativo (8.1)']::text[], 'access_probed'),
      ('F02', 'Portal da Transparencia de Varzea Grande', 'www.varzeagrande.mt.gov.br', 'Prefeitura Municipal de Varzea Grande', 'municipal', array['expense','revenue','contract','agreement']::text[], 'html', false, array['e um indice: cada destino exige teste individual','CNPJ 03.507.548/0001-10 e o ente principal, nao a familia completa de fundos e autarquias (8.2)']::text[], 'access_probed'),
      ('F03', 'Portal municipal de emendas parlamentares', 'emendas.varzeagrande.mt.gov.br', 'Prefeitura Municipal de Varzea Grande', 'municipal', array['amendment']::text[], 'html', false, array['escopo, paginacao e acesso estruturado nao validados']::text[], 'access_probed'),
      ('F04', 'Diario Oficial de Varzea Grande', 'diariooficial.varzeagrande.mt.gov.br', 'Prefeitura Municipal de Varzea Grande', 'municipal', array['official_act','contract','amendment_act']::text[], 'document', false, array['arquivo historico e qualidade dos documentos nao medidos','edicoes antigas podem exigir OCR, que e ultimo recurso (13.2)']::text[], 'access_probed'),
      ('F05', 'Jornal Oficial AMM-MT', 'amm.diariomunicipal.org', 'Associacao Mato-grossense dos Municipios', 'association', array['official_act']::text[], 'document', false, array['nao presumir que substitui todo o diario proprio do municipio (8.2)']::text[], 'access_probed'),
      ('F06', 'PNCP - Portal Nacional de Contratacoes Publicas', 'pncp.gov.br', 'Governo Federal', 'federal', array['procurement','contract']::text[], 'api', false, array['recorte e historico a verificar; endpoints devem sair da documentacao oficial, nao de suposicao']::text[], 'access_probed'),
      ('F07', 'Portal da Transparencia - API de dados (CGU)', 'api.portaldatransparencia.gov.br', 'Controladoria-Geral da Uniao', 'federal', array['amendment','financial_event']::text[], 'api', true, array['uso da API exige cadastro e token','limites de requisicao a confirmar']::text[], 'access_probed'),
      ('F10', 'Transferegov.br - APIs de dados abertos', 'api-publica.transferegov.gestao.gov.br', 'Ministerio da Gestao e da Inovacao em Servicos Publicos', 'federal', array['transfer_instrument','financial_event']::text[], 'api', false, array['modulos, filtros e modelos a validar']::text[], 'access_probed'),
      ('F24', 'Geo-obras Cidadao / TCE-MT', 'geoobras.tce.mt.gov.br', 'Tribunal de Contas do Estado de Mato Grosso', 'state', array['public_work']::text[], 'html', false, array['sem API, exportacao ou coleta automatizada confirmada']::text[], 'blocked')
  ) as x(code, official_name, domain, organ, sphere, record_types, access_method,
         requires_credentials, known_limitations, integration_status)
 where t.slug = 'varzea-grande'
on conflict (tenant_id, code) do update
   set official_name = excluded.official_name,
       integration_status = excluded.integration_status,
       known_limitations = excluded.known_limitations;

insert into ma.source_datasets (tenant_id, source_id, name, record_type, cadence, stale_after_hours)
select s.tenant_id, s.id, d.name, d.record_type, d.cadence, d.stale_after_hours
  from ma.sources s
  join ma.tenants t on t.id = s.tenant_id and t.slug = 'varzea-grande'
  join (values
    ('F01', 'noticias', 'news', 'duas janelas diarias', 36),
    ('F02', 'contratos', 'contract', 'duas janelas diarias', 36),
    ('F02', 'despesas', 'expense', 'duas janelas diarias', 36),
    ('F03', 'emendas', 'amendment', 'duas janelas diarias', 36),
    ('F04', 'edicoes', 'official_act', 'duas janelas diarias', 36),
    ('F05', 'publicacoes-vg', 'official_act', 'duas janelas diarias', 36),
    ('F06', 'contratos', 'contract', 'duas janelas diarias', 36),
    ('F07', 'emendas', 'amendment', 'duas janelas diarias', 36),
    ('F10', 'instrumentos', 'transfer_instrument', 'semanal', 240),
    ('F24', 'obras', 'public_work', 'semanal', 240)
  ) as d(code, name, record_type, cadence, stale_after_hours) on d.code = s.code
on conflict (source_id, name) do update set cadence = excluded.cadence;
