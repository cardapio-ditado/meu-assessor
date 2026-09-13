-- 0003_entities_claims.sql
-- Entidades, afirmacoes, relacoes e eventos financeiros. Briefing 10.2, A.3-A.5.
-- `extensions` no caminho porque em Postgres gerenciado (Supabase) as
-- extensoes vivem nesse schema: sem ele, gen_random_uuid() e digest() nao
-- resolvem. Um schema inexistente no search_path e ignorado, entao a linha
-- e inofensiva em Postgres proprio.
set search_path to ma, public, extensions;

create table ma.entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  municipality_id uuid not null references ma.municipalities(id),
  kind ma.entity_kind not null,
  official_name text not null,
  name_normalized text not null,
  aliases text[] not null default '{}',
  -- Identificador oficial quando existe + o original de cada fonte (10.3).
  external_ids jsonb not null default '{}'::jsonb,
  locality_id uuid references ma.localities(id),
  organ_id uuid references ma.organs(id),
  area text,
  status_label text,
  access_class ma.access_class not null default 'public',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

-- Busca textual em portugues sobre nome e area. Aliases NAO entram no
-- tsvector: array_to_string nao e imutavel, e a busca por apelido local
-- confirmado (T03) e resolvida pelo indice de array e por trigrama no
-- pacote de recuperacao, que preserva o nome oficial na resposta.
alter table ma.entities
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('portuguese', coalesce(official_name, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(area, '')), 'C')
  ) stored;

create index on ma.entities using gin (search_vector);
create index on ma.entities using gin (name_normalized gin_trgm_ops);
create index on ma.entities using gin (aliases);
create index on ma.entities (tenant_id, kind);
create index on ma.entities using gin (external_ids jsonb_path_ops);

-- Tabela de correspondencia entre identificadores de fontes (10.3).
-- Associacao por similaridade textual PERMANECE candidata.
create table ma.entity_matches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  entity_id uuid not null references ma.entities(id) on delete cascade,
  source_id uuid not null references ma.sources(id) on delete cascade,
  external_id text not null,
  match_method text not null check (match_method in ('official_id','curated_alias','textual_similarity','manual')),
  similarity_score numeric(5,4),
  validation_state ma.validation_state not null default 'candidate',
  reviewed_by text,
  review_justification text,
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, source_id, external_id, entity_id),
  -- Similaridade textual nunca nasce publicada nem auto-validada (10.3):
  -- "Uma associacao por similaridade textual deve permanecer candidata."
  constraint similarity_stays_candidate check (
    match_method <> 'textual_similarity'
    or validation_state in ('candidate','human_reviewed','in_conflict','withdrawn')
  )
);

-- Afirmacao e evidencia (A.3). O registro de referencia do produto.
create table ma.claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  subject_id uuid not null references ma.entities(id) on delete cascade,
  predicate text not null,
  value_text text,
  value_numeric numeric(20,4),
  value_date date,
  value_boolean boolean,
  -- Valor monetario em decimal exato, nunca float (10.4).
  value_money numeric(18,2),
  currency char(3),
  value_type text not null check (value_type in ('text','integer','decimal','date','boolean','money','null')),
  unit text,
  qualifiers jsonb not null default '{}'::jsonb,
  valid_from date,
  valid_to date,
  fact_date date,
  recorded_at timestamptz not null default now(),
  retired_at timestamptz,
  state ma.evidence_state not null,
  validation_state ma.validation_state not null default 'candidate',
  freshness_class ma.freshness_class not null default 'undefined',
  -- 10.4: null para desconhecido, com motivo. Zero nao substitui ausencia.
  null_reason text,
  reviewed_by text,
  review_method text,
  supersedes_id uuid references ma.claims(id),
  access_class ma.access_class not null default 'public',
  is_synthetic boolean not null default false,
  constraint null_needs_reason check (value_type <> 'null' or null_reason is not null),
  constraint money_needs_currency check (value_type <> 'money' or (value_money is not null and currency is not null))
);

create index on ma.claims (tenant_id, subject_id, predicate);
create index on ma.claims (tenant_id, predicate, validation_state);
create index on ma.claims (retired_at) where retired_at is null;

-- Uma afirmacao publicada precisa de pelo menos uma evidencia. A tabela de
-- ligacao existe para que a evidencia seja especifica, nao "o nome do portal".
create table ma.claim_evidence (
  claim_id uuid not null references ma.claims(id) on delete cascade,
  evidence_id uuid not null references ma.evidence(id) on delete restrict,
  supports text not null default 'value' check (supports in ('value','period','identity','stage','negation')),
  primary key (claim_id, evidence_id)
);

-- Relacao de agente publico (A.5). "mencionado em noticia" nunca vira autoria.
create table ma.person_relations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  person_id uuid not null references ma.entities(id) on delete cascade,
  related_entity_id uuid not null references ma.entities(id) on delete cascade,
  relation_type ma.relation_type not null,
  role_at_date text,
  valid_from date,
  valid_to date,
  sphere text check (sphere in ('municipal','state','federal')),
  documented_share_money numeric(18,2),
  currency char(3),
  match_method text not null check (match_method in ('official_id','curated_alias','textual_similarity','manual')),
  validation_state ma.validation_state not null default 'candidate',
  evidence_ids uuid[] not null default '{}',
  access_class ma.access_class not null default 'public',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

create index on ma.person_relations (tenant_id, person_id, relation_type);
create index on ma.person_relations (tenant_id, related_entity_id);

-- Evento financeiro (A.4).
create table ma.financial_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  source_id uuid not null references ma.sources(id) on delete restrict,
  external_id text not null,
  payer_entity_id uuid references ma.entities(id),
  payee_entity_id uuid references ma.entities(id),
  instrument_id uuid references ma.entities(id),
  subject_id uuid references ma.entities(id),
  financial_document text,
  cancels_event_id uuid references ma.financial_events(id),
  stage ma.financial_stage not null,
  fact_date date,
  budget_year integer,
  amendment_year integer,
  amount_money numeric(18,2) not null,
  currency char(3) not null default 'BRL',
  measure ma.flow_measure not null default 'flow',
  link_confirmed boolean not null default false,
  reconciliation_state text not null default 'unreconciled'
    check (reconciliation_state in ('unreconciled','reconciled','duplicate_of')),
  duplicate_of_id uuid references ma.financial_events(id),
  evidence_ids uuid[] not null default '{}',
  access_class ma.access_class not null default 'public',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  -- Chave estavel por fonte: repetir o lote nao cria pagamento novo (13.3).
  unique (tenant_id, source_id, external_id),
  constraint duplicate_needs_target check (reconciliation_state <> 'duplicate_of' or duplicate_of_id is not null)
);

create index on ma.financial_events (tenant_id, stage, fact_date);
create index on ma.financial_events (tenant_id, payee_entity_id, stage);
create index on ma.financial_events (tenant_id, subject_id);
create index on ma.financial_events (financial_document) where financial_document is not null;

-- Elos da cadeia de rastreabilidade (11.3): cada seta precisa de identificador
-- compartilhado ou evidencia documental.
create table ma.chain_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  from_entity_id uuid not null references ma.entities(id) on delete cascade,
  to_entity_id uuid not null references ma.entities(id) on delete cascade,
  from_step text not null,
  to_step text not null,
  shared_identifier text,
  evidence_ids uuid[] not null default '{}',
  fact_date date,
  validation_state ma.validation_state not null default 'candidate',
  constraint link_needs_support check (
    shared_identifier is not null or cardinality(evidence_ids) > 0
      or validation_state in ('candidate','withdrawn')
  )
);
