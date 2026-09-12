-- 0004_answers_audit.sql
-- Consultas, respostas, cache, revisao e auditoria. Briefing 10.2, 12.5, 16.3, 21.2.
-- `extensions` no caminho porque em Postgres gerenciado (Supabase) as
-- extensoes vivem nesse schema: sem ele, gen_random_uuid() e digest() nao
-- resolvem. Um schema inexistente no search_path e ignorado, entao a linha
-- e inofensiva em Postgres proprio.
set search_path to ma, public, extensions;

-- Trilha da resposta (12.5): "A trilha de auditoria precisa mostrar o que foi
-- dito, com quais fontes e quando houve retificacao."
create table ma.answers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  user_id uuid not null references ma.users(id) on delete restrict,
  question_text text not null,
  question_normalized text not null,
  plan jsonb not null,
  status text not null check (status in ('complete','partial','clarification_needed','no_evidence','unavailable')),
  summary text not null,
  envelope jsonb not null,
  claim_ids uuid[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  data_version text not null,
  prompt_version text not null,
  model_id text,
  validator_verdict text not null check (validator_verdict in ('passed','reduced','abstained','blocked')),
  validator_detail jsonb not null default '{}'::jsonb,
  latency_ms integer,
  -- 12.5: correcao posterior marca a resposta afetada, sem reescrever o texto.
  affected_by_correction_at timestamptz,
  correction_note text,
  created_at timestamptz not null default now()
);

create index on ma.answers (tenant_id, user_id, created_at desc);
create index on ma.answers using gin (claim_ids);

-- Cache com escopo completo (16.3): organizacao, municipio, acesso, consulta,
-- entidades, periodo, versao do conjunto e versao das instrucoes.
create table ma.answer_cache (
  cache_key text primary key,
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  municipality_id uuid not null references ma.municipalities(id),
  access_signature text not null,
  envelope jsonb not null,
  depends_on_claim_ids uuid[] not null default '{}',
  depends_on_document_ids uuid[] not null default '{}',
  data_version text not null,
  prompt_version text not null,
  valid_until timestamptz not null,
  created_at timestamptz not null default now()
);

create index on ma.answer_cache (tenant_id);
create index on ma.answer_cache using gin (depends_on_claim_ids);
create index on ma.answer_cache (valid_until);

-- Fila de revisao (21.2): o revisor nao deve precisar reprocurar as fontes.
create table ma.review_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  kind text not null check (kind in ('claim','entity_match','person_relation','financial_link','conflict','feedback')),
  target_id uuid,
  reason text not null,
  impact text not null check (impact in ('affects_emitted_answer','high_risk_field','frequent_subject','active_process','low_demand')),
  original_extraction jsonb,
  proposed_value jsonb,
  evidence_ids uuid[] not null default '{}',
  priority integer not null default 50,
  state text not null default 'open' check (state in ('open','in_review','approved','corrected','rejected','document_requested','conflict_kept')),
  assigned_to text,
  decided_by text,
  decision_justification text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint decision_needs_justification check (
    state in ('open','in_review') or decision_justification is not null
  )
);

create index on ma.review_queue (tenant_id, state, priority desc, created_at);

-- Conflitos preservados com as duas versoes (12.3).
create table ma.conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  subject_id uuid not null references ma.entities(id) on delete cascade,
  predicate text not null,
  claim_a_id uuid not null references ma.claims(id) on delete cascade,
  claim_b_id uuid not null references ma.claims(id) on delete cascade,
  -- Antes de classificar conflito: mesmo objeto, periodo, unidade, etapa e escopo?
  same_object boolean not null,
  same_period boolean not null,
  same_stage boolean not null,
  difference_description text not null,
  precedence_rule text,
  state text not null default 'open' check (state in ('open','resolved','false_conflict')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint distinct_claims check (claim_a_id <> claim_b_id)
);

-- Lacunas visiveis (9.4, 7.6): pergunta concreta e unidade competente.
create table ma.gaps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  subject_id uuid references ma.entities(id) on delete cascade,
  missing_field text not null,
  concrete_question text not null,
  competent_organ_id uuid references ma.organs(id),
  authorized_channel text,
  state text not null default 'open' check (state in ('open','requested','answered','closed')),
  created_at timestamptz not null default now()
);

-- Matriz de cobertura verificavel (9.3).
create table ma.coverage_matrix (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  dataset_id uuid not null references ma.source_datasets(id) on delete cascade,
  requested_from date,
  requested_to date,
  found_from date,
  found_to date,
  temporal_coverage text not null check (temporal_coverage in ('complete_per_provider','partial','unavailable','not_tested')),
  record_count integer not null default 0,
  failure_count integer not null default 0,
  field_coverage jsonb not null default '{}'::jsonb,
  known_limitation text,
  last_verified_at timestamptz,
  verified_by text,
  unique (dataset_id, requested_from, requested_to)
);

-- Tarefas de pesquisa complementar (15.4): identificador real, orcamento e
-- cancelamento. Nao prometer trabalho em segundo plano sem isto.
create table ma.research_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  user_id uuid not null references ma.users(id) on delete restrict,
  answer_id uuid references ma.answers(id) on delete set null,
  idempotency_key text not null,
  question text not null,
  target_gap text not null,
  state text not null default 'pending' check (state in ('pending','running','succeeded','failed','cancelled','budget_exceeded')),
  max_duration_seconds integer not null default 300,
  max_sources integer not null default 5,
  budget_note text,
  attempts integer not null default 0,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, idempotency_key)
);

-- Auditoria de acesso e alteracao.
create table ma.audit_log (
  id bigserial primary key,
  tenant_id uuid references ma.tenants(id) on delete set null,
  actor text not null,
  action text not null,
  object_kind text not null,
  object_id text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index on ma.audit_log (tenant_id, at desc);
create index on ma.audit_log (object_kind, object_id);
