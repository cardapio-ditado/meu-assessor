-- 0001_base.sql
-- Fundacao multi-organizacao. Briefing 10.2, 20.3, A.1.
-- Toda tabela de negocio carrega tenant_id e tem RLS. O papel de aplicacao e
-- criado NOBYPASSRLS (ver docs/runbooks/banco.md): ativar RLS sem isso nao
-- isola nada (F17).

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create schema if not exists ma;
set search_path to ma, public;

-- Contexto da requisicao. Definido pelo servidor a cada transacao a partir da
-- sessao autenticada; NUNCA a partir de um campo enviado pelo navegador (B.2).
create or replace function ma.current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('ma.tenant_id', true), '')::uuid
$$;

create or replace function ma.current_access_classes() returns text[]
language sql stable as $$
  select coalesce(
    string_to_array(nullif(current_setting('ma.access_classes', true), ''), ','),
    array['public']::text[]
  )
$$;

create type ma.access_class as enum ('public', 'internal_authorized', 'restricted', 'blocked');

create type ma.validation_state as enum (
  'received','extracted','candidate','auto_validated','human_reviewed',
  'published','in_conflict','stale','superseded','withdrawn'
);

create type ma.evidence_state as enum (
  'documented','source_reported','partial','divergent','not_located','stale_for_question'
);

create type ma.financial_stage as enum (
  'announced','indicated','committed','liquidated','transferred','received','paid_supplier','cancelled'
);

create type ma.freshness_class as enum ('stable_history','mutable_operational','critical','undefined');

create type ma.entity_kind as enum (
  'organ','public_person','locality','subject','procurement','contract',
  'amendment','transfer_instrument','news_item'
);

create type ma.relation_type as enum (
  'author','coauthor','collective_bench','instrument_proposer','grantor',
  'paying_unit','beneficiary','executor','contractor','signatory_as_rep',
  'rapporteur','mentioned_by_source','unproven_link'
);

create type ma.flow_measure as enum ('flow','cumulative_position');

-- Organizacao cliente (tenant) e municipio sao coisas distintas (10.2).
create table ma.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table ma.municipalities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  uf char(2) not null,
  ibge_code text,                    -- a confirmar na implantacao
  time_zone text not null,
  primary_cnpj text,
  created_at timestamptz not null default now(),
  unique (name, uf)
);

create table ma.tenant_municipalities (
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  municipality_id uuid not null references ma.municipalities(id) on delete restrict,
  primary key (tenant_id, municipality_id)
);

-- Identidade vem do mecanismo de autenticacao e do cadastro validado, nunca
-- do nome dito em um audio (4.2). Nome de exibicao, cargo e prefeitura sao
-- campos separados.
create table ma.users (
  id uuid primary key default gen_random_uuid(),
  login text not null unique,
  display_name text not null,
  job_title text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- Acumulacao de perfis e permitida no piloto, mas fica visivel (4.1).
create table ma.user_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references ma.users(id) on delete cascade,
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  role text not null check (role in (
    'manager','cabinet','data_curator','technical_validator',
    'municipal_admin','platform_ops','auditor'
  )),
  access_classes ma.access_class[] not null default array['public']::ma.access_class[],
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, tenant_id, role)
);

-- Cargos e secretarias tem vigencia: trocar de secretario nao reescreve o
-- passado (4.2).
create table ma.organs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  municipality_id uuid not null references ma.municipalities(id),
  name text not null,
  acronym text,
  cnpj text,
  organ_type text,
  parent_organ_id uuid references ma.organs(id),
  valid_from date,
  valid_to date,
  access_class ma.access_class not null default 'public'
);

create table ma.localities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references ma.tenants(id) on delete cascade,
  municipality_id uuid not null references ma.municipalities(id),
  official_name text not null,
  aliases text[] not null default '{}',
  locality_type text,
  access_class ma.access_class not null default 'public'
);

create index on ma.localities using gin (aliases);
create index on ma.localities using gin (official_name gin_trgm_ops);
