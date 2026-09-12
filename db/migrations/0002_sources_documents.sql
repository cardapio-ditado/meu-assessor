-- 0002_sources_documents.sql
-- Fontes, documentos, versoes e evidencias. Briefing 8.4, A.2, A.3, 12.1.
set search_path to ma, public;

-- Ficha obrigatoria de cada fonte (8.4). Uma fonte pode ter varios conjuntos
-- de dados com cadencias diferentes, por isso source_datasets.
create table ma.sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  code text not null,
  official_name text not null,
  domain text not null,
  organ text not null,
  sphere text not null check (sphere in ('municipal','state','federal','association','other')),
  record_types text[] not null default '{}',
  access_method text not null check (access_method in ('api','structured_export','html','document','manual')),
  requires_credentials boolean not null default false,
  -- Periodo EFETIVAMENTE disponivel, nao o desejado (8.4).
  available_from date,
  available_to date,
  desired_frequency text not null default 'diaria',
  reuse_terms text,
  access_class ma.access_class not null default 'public',
  operational_owner text not null,
  connector_version text not null default '0.0.0',
  known_limitations text[] not null default '{}',
  -- Situacao de integracao: "pagina localizada" nao e "conector testado" (C.2).
  integration_status text not null default 'page_located'
    check (integration_status in ('page_located','access_probed','connector_built','connector_verified','blocked')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table ma.source_datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  source_id uuid not null references ma.sources(id) on delete cascade,
  name text not null,
  record_type text not null,
  cadence text not null default 'diaria',
  -- A saude da homepage nao prova que este conjunto atualizou (8.4).
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  provider_updated_at timestamptz,
  cursor_value text,
  stale_after_hours integer not null default 48,
  unique (source_id, name)
);

-- Execucoes de coleta: evidencia de que a rotina rodou (14.1, 24.x).
create table ma.source_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  dataset_id uuid not null references ma.source_datasets(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('success','partial','failed','quarantined')),
  requested_from date,
  requested_to date,
  found_from date,
  found_to date,
  expected_count integer,
  obtained_count integer not null default 0,
  rejected_count integer not null default 0,
  checkpoint text,
  error_class text,
  error_detail text,
  cost_note text
);

create index on ma.source_runs (dataset_id, started_at desc);

-- Documento e versao (A.2). Versoes nao se sobrescrevem (7.8, 12.5).
create table ma.document_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  source_id uuid not null references ma.sources(id) on delete restrict,
  external_id text,
  document_type text,
  title_original text not null,
  title_normalized text not null,
  issuing_organ text,
  number_original text,
  number_normalized text,
  fiscal_year integer,
  url_original text,
  url_final text,
  -- Os papeis de data do 12.2 em colunas proprias.
  publication_date date,
  signature_date date,
  reference_date date,
  collected_at timestamptz not null default now(),
  object_key text,
  mime_type text,
  byte_size bigint,
  content_hash text not null,
  extraction_method text not null check (extraction_method in ('native_text','structured','html','ocr','manual')),
  parser_version text not null,
  language text not null default 'pt-BR',
  text_content text,
  extraction_quality text not null default 'high'
    check (extraction_quality in ('high','uncertain','requires_review')),
  access_class ma.access_class not null default 'public',
  record_version integer not null default 1,
  supersedes_id uuid references ma.document_versions(id),
  -- 1.2: dado ficticio sempre identificado e separado do real.
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_id, external_id, record_version)
);

-- Busca textual em portugues (F22). A coluna e gerada: nao ha como o indice
-- divergir do texto armazenado.
alter table ma.document_versions
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('portuguese', coalesce(title_normalized, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(left(text_content, 400000), '')), 'B')
  ) stored;

create index on ma.document_versions using gin (search_vector);
create index on ma.document_versions (tenant_id, publication_date desc);
create index on ma.document_versions (content_hash);
create index on ma.document_versions using gin (title_normalized gin_trgm_ops);

-- Evidencia: trecho ancorado, com parametros de consulta sem credenciais (12.1).
create table ma.evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  document_version_id uuid not null references ma.document_versions(id) on delete cascade,
  locator text not null,
  snippet text not null,
  query_parameters jsonb,
  obtained_at timestamptz not null default now(),
  access_class ma.access_class not null default 'public',
  constraint evidence_snippet_not_empty check (length(btrim(snippet)) > 0)
);

create index on ma.evidence (document_version_id);
