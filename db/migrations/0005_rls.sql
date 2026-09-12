-- 0005_rls.sql
-- Isolamento por organizacao e por classe de acesso. Briefing 20.3.
--
-- F17 / briefing 20.3: "proprietarios, superusuarios e papeis com privilegios
-- especificos podem contorna-las em certas condicoes. Usar papel de aplicacao
-- sem privilegios de bypass e TESTAR as politicas, em vez de presumir que
-- ativar RLS resolve todo o isolamento."
--
-- Por isso: (1) FORCE ROW LEVEL SECURITY, que faz a politica valer tambem para
-- o dono da tabela; (2) o papel de aplicacao e criado NOBYPASSRLS; (3) os
-- testes em tests/security/ provam o isolamento em vez de assumi-lo.
set search_path to ma, public;

-- Tabelas com tenant_id: politica de organizacao + classe de acesso.
do $$
declare
  t text;
  tenant_scoped text[] := array[
    'sources','source_datasets','source_runs','document_versions','evidence',
    'entities','entity_matches','claims','person_relations','financial_events',
    'chain_links','answers','answer_cache','review_queue','conflicts','gaps',
    'coverage_matrix','research_jobs','organs','localities','user_grants','audit_log'
  ];
begin
  foreach t in array tenant_scoped loop
    execute format('alter table ma.%I enable row level security', t);
    execute format('alter table ma.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on ma.%I', t);
    execute format($p$
      create policy tenant_isolation on ma.%I
        using (tenant_id = ma.current_tenant())
        with check (tenant_id = ma.current_tenant())
    $p$, t);
  end loop;
end $$;

-- audit_log permite tenant_id nulo (evento de plataforma); a politica acima
-- ja barra leitura desses registros por um tenant, o que e o comportamento
-- desejado: operacao da plataforma le por outro caminho auditado.

-- Classe de acesso: alem da organizacao, a sessao le apenas as classes que
-- seus grants concedem. Aplicado nas tabelas que carregam conteudo.
do $$
declare
  t text;
  classified text[] := array[
    'document_versions','evidence','claims','person_relations','financial_events','entities'
  ];
begin
  foreach t in array classified loop
    execute format('drop policy if exists access_class_filter on ma.%I', t);
    execute format($p$
      create policy access_class_filter on ma.%I
        as restrictive
        using (access_class::text = any (ma.current_access_classes()))
        with check (access_class::text = any (ma.current_access_classes()))
    $p$, t);
  end loop;
end $$;

-- claim_evidence nao tem tenant_id proprio: herda pela FK. A politica
-- restritiva garante que a ligacao so e visivel se ambos os lados forem.
alter table ma.claim_evidence enable row level security;
alter table ma.claim_evidence force row level security;
drop policy if exists inherited_isolation on ma.claim_evidence;
create policy inherited_isolation on ma.claim_evidence
  using (
    exists (select 1 from ma.claims c where c.id = claim_id)
    and exists (select 1 from ma.evidence e where e.id = evidence_id)
  )
  with check (
    exists (select 1 from ma.claims c where c.id = claim_id)
    and exists (select 1 from ma.evidence e where e.id = evidence_id)
  );

-- Tabelas globais de configuracao: leitura ampla, escrita so por migracao
-- ou operacao. tenant_municipalities e filtrado por tenant.
alter table ma.tenant_municipalities enable row level security;
alter table ma.tenant_municipalities force row level security;
drop policy if exists tenant_isolation on ma.tenant_municipalities;
create policy tenant_isolation on ma.tenant_municipalities
  using (tenant_id = ma.current_tenant())
  with check (tenant_id = ma.current_tenant());

-- users e tenants/municipalities nao tem RLS por tenant: sao consultados pelo
-- caminho de autenticacao antes de existir contexto. O acesso e restringido
-- por grants na aplicacao e auditado.
