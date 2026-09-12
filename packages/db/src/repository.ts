/**
 * Ferramentas de leitura tipadas. Briefing 15.3: "O modelo nao deve executar
 * SQL arbitrario com permissao ampla. Preferir ferramentas de consulta com
 * parametros tipados e operacoes de leitura definidas."
 *
 * Este arquivo e a lista completa dessas operacoes. Nao existe funcao que
 * aceite SQL de fora.
 */
import { money } from '../../domain/src/money.ts';
import { instant, plainDate, tryPlainDate } from '../../domain/src/temporal.ts';
import type { PlainDate, DateRange } from '../../domain/src/temporal.ts';
import type {
  AccessClass,
  EvidenceState,
  FinancialStage,
  FreshnessClass,
  RelationType,
  ValidationState,
} from '../../domain/src/states.ts';
import type {
  Claim,
  Entity,
  EntityKind,
  Evidence,
  FinancialEvent,
  TimelineItem,
} from '../../domain/src/types.ts';
import type { QueryRunner } from './pool.ts';

export async function getEntity(db: QueryRunner, id: string): Promise<Entity | null> {
  const r = await db.query<EntityRow>(
    `select e.id, e.tenant_id, e.municipality_id, e.kind::text as kind, e.official_name,
            e.aliases, e.external_ids, e.locality_id, e.area, e.access_class::text as access_class
       from ma.entities e where e.id = $1`,
    [id],
  );
  const row = r.rows[0];
  return row === undefined ? null : mapEntity(row);
}

interface EntityRow {
  id: string;
  tenant_id: string;
  municipality_id: string;
  kind: string;
  official_name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  locality_id: string | null;
  area: string | null;
  access_class: string;
}

function mapEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    municipalityId: row.municipality_id,
    kind: row.kind as EntityKind,
    officialName: row.official_name,
    aliases: row.aliases,
    externalIds: row.external_ids,
    localityId: row.locality_id,
    areaId: row.area,
    accessClass: row.access_class as AccessClass,
  };
}

interface ClaimRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  subject_kind: string;
  predicate: string;
  value_text: string | null;
  value_numeric: string | null;
  value_date: string | null;
  value_boolean: boolean | null;
  value_money: string | null;
  currency: string | null;
  value_type: string;
  unit: string | null;
  qualifiers: Record<string, string>;
  valid_from: string | null;
  valid_to: string | null;
  fact_date: string | null;
  recorded_at: string;
  retired_at: string | null;
  state: string;
  validation_state: string;
  freshness_class: string;
  null_reason: string | null;
  reviewed_by: string | null;
  review_method: string | null;
  access_class: string;
  evidence_ids: string[];
}

function mapClaim(row: ClaimRow): Claim {
  const value =
    row.value_type === 'money'
      ? null
      : row.value_type === 'boolean'
        ? row.value_boolean
        : row.value_type === 'date'
          ? row.value_date
          : row.value_type === 'integer' || row.value_type === 'decimal'
            ? row.value_numeric === null
              ? null
              : Number(row.value_numeric)
            : row.value_text;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    subjectKind: row.subject_kind as EntityKind,
    predicate: row.predicate,
    value,
    valueType: row.value_type as Claim['valueType'],
    money:
      row.value_money === null || row.currency === null
        ? null
        : money(BigInt(Math.round(Number(row.value_money) * 100)), 'BRL'),
    unit: row.unit,
    qualifiers: row.qualifiers,
    validFrom: tryPlainDate(row.valid_from),
    validTo: tryPlainDate(row.valid_to),
    factDate: tryPlainDate(row.fact_date),
    recordedAt: instant(row.recorded_at),
    retiredAt: row.retired_at === null ? null : instant(row.retired_at),
    evidenceIds: row.evidence_ids.filter((x) => x !== null),
    state: row.state as EvidenceState,
    validationState: row.validation_state as ValidationState,
    freshnessClass: row.freshness_class as FreshnessClass,
    nullReason: row.null_reason,
    reviewedBy: row.reviewed_by,
    reviewMethod: row.review_method,
    accessClass: row.access_class as AccessClass,
  };
}

const CLAIM_SELECT = `
  select c.id, c.tenant_id, c.subject_id, e.kind::text as subject_kind, c.predicate,
         c.value_text, c.value_numeric::text as value_numeric, c.value_date::text as value_date,
         c.value_boolean, c.value_money::text as value_money, c.currency,
         c.value_type, c.unit, c.qualifiers,
         c.valid_from::text as valid_from, c.valid_to::text as valid_to,
         c.fact_date::text as fact_date, c.recorded_at, c.retired_at,
         c.state::text as state, c.validation_state::text as validation_state,
         c.freshness_class::text as freshness_class, c.null_reason,
         c.reviewed_by, c.review_method, c.access_class::text as access_class,
         coalesce(array_agg(ce.evidence_id) filter (where ce.evidence_id is not null), '{}') as evidence_ids
    from ma.claims c
    join ma.entities e on e.id = c.subject_id
    left join ma.claim_evidence ce on ce.claim_id = c.id
`;

/** Afirmacoes vigentes de um assunto. Versoes retiradas nao vem por aqui. */
export async function getClaims(
  db: QueryRunner,
  subjectId: string,
  options: { readonly includeRetired?: boolean } = {},
): Promise<Claim[]> {
  const r = await db.query<ClaimRow>(
    `${CLAIM_SELECT}
      where c.subject_id = $1
        and ($2::boolean or c.retired_at is null)
      group by c.id, e.kind
      order by c.predicate, c.recorded_at desc`,
    [subjectId, options.includeRetired ?? false],
  );
  return r.rows.map(mapClaim);
}

/**
 * 12.2 / T22: "Qual era o prazo em marco?" usa a versao valida NAQUELE
 * periodo, no eixo de validade administrativa.
 */
export async function getClaimsValidOn(
  db: QueryRunner,
  subjectId: string,
  at: PlainDate,
): Promise<Claim[]> {
  const r = await db.query<ClaimRow>(
    `${CLAIM_SELECT}
      where c.subject_id = $1
        and (c.valid_from is null or c.valid_from <= $2::date)
        and (c.valid_to is null or c.valid_to >= $2::date)
      group by c.id, e.kind
      order by c.predicate, c.recorded_at desc`,
    [subjectId, at],
  );
  return r.rows.map(mapClaim);
}

/**
 * 12.2 / T23: "O que sabiamos em marco?" usa o eixo de conhecimento da
 * plataforma (recorded_at / retired_at).
 */
export async function getClaimsKnownAt(
  db: QueryRunner,
  subjectId: string,
  at: PlainDate,
): Promise<Claim[]> {
  const r = await db.query<ClaimRow>(
    `${CLAIM_SELECT}
      where c.subject_id = $1
        and c.recorded_at <= ($2::date + interval '1 day')
        and (c.retired_at is null or c.retired_at > ($2::date + interval '1 day'))
      group by c.id, e.kind
      order by c.predicate, c.recorded_at desc`,
    [subjectId, at],
  );
  return r.rows.map(mapClaim);
}

export async function getEvidence(db: QueryRunner, ids: readonly string[]): Promise<Map<string, Evidence>> {
  if (ids.length === 0) return new Map();
  const r = await db.query<{
    id: string;
    tenant_id: string;
    document_version_id: string;
    locator: string;
    snippet: string;
    query_parameters: Record<string, string> | null;
    obtained_at: string;
    access_class: string;
  }>(
    `select id, tenant_id, document_version_id, locator, snippet, query_parameters,
            obtained_at, access_class::text as access_class
       from ma.evidence where id = any($1::uuid[])`,
    [ids],
  );
  return new Map(
    r.rows.map((row) => [
      row.id,
      {
        id: row.id,
        tenantId: row.tenant_id,
        documentVersionId: row.document_version_id,
        locator: row.locator,
        snippet: row.snippet,
        queryParameters: row.query_parameters,
        obtainedAt: instant(row.obtained_at),
        accessClass: row.access_class as AccessClass,
      },
    ]),
  );
}

/** Municipio de cada documento, para o validador conferir contexto (T32/T33). */
export async function getDocumentMunicipalities(
  db: QueryRunner,
  documentVersionIds: readonly string[],
): Promise<Map<string, string>> {
  if (documentVersionIds.length === 0) return new Map();
  const r = await db.query<{ id: string; municipality_id: string }>(
    `select d.id, m.id as municipality_id
       from ma.document_versions d
       join ma.tenants t on t.id = d.tenant_id
       join ma.tenant_municipalities tm on tm.tenant_id = t.id
       join ma.municipalities m on m.id = tm.municipality_id
      where d.id = any($1::uuid[])`,
    [documentVersionIds],
  );
  return new Map(r.rows.map((row) => [row.id, row.municipality_id]));
}

export async function getFinancialEvents(
  db: QueryRunner,
  filter: {
    readonly subjectId?: string | null;
    readonly payeeEntityId?: string | null;
    readonly instrumentId?: string | null;
    readonly stages?: readonly FinancialStage[];
    readonly period?: DateRange | null;
  },
): Promise<FinancialEvent[]> {
  const r = await db.query<{
    id: string; tenant_id: string; source_id: string; external_id: string;
    payer_entity_id: string | null; payee_entity_id: string | null;
    instrument_id: string | null; subject_id: string | null;
    financial_document: string | null; cancels_event_id: string | null;
    stage: string; fact_date: string | null; budget_year: number | null;
    amendment_year: number | null; amount_money: string; currency: string;
    measure: string; link_confirmed: boolean; reconciliation_state: string;
    duplicate_of_id: string | null; evidence_ids: string[];
    access_class: string; is_synthetic: boolean;
  }>(
    `select id, tenant_id, source_id, external_id, payer_entity_id, payee_entity_id,
            instrument_id, subject_id, financial_document, cancels_event_id,
            stage::text as stage, fact_date::text as fact_date, budget_year, amendment_year,
            amount_money::text as amount_money, currency, measure::text as measure,
            link_confirmed, reconciliation_state, duplicate_of_id, evidence_ids,
            access_class::text as access_class, is_synthetic
       from ma.financial_events
      where ($1::uuid is null or subject_id = $1::uuid)
        and ($2::uuid is null or payee_entity_id = $2::uuid)
        and ($3::uuid is null or instrument_id = $3::uuid)
        and ($4::text[] is null or stage::text = any($4) or stage = 'cancelled')
        and ($5::date is null or fact_date is null or fact_date >= $5::date)
        and ($6::date is null or fact_date is null or fact_date <= $6::date)
      order by fact_date nulls last, external_id`,
    [
      filter.subjectId ?? null,
      filter.payeeEntityId ?? null,
      filter.instrumentId ?? null,
      filter.stages !== undefined && filter.stages.length > 0 ? filter.stages : null,
      filter.period?.from ?? null,
      filter.period?.to ?? null,
    ],
  );
  return r.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    payerEntityId: row.payer_entity_id,
    payeeEntityId: row.payee_entity_id,
    instrumentId: row.instrument_id,
    subjectId: row.subject_id,
    financialDocument: row.financial_document,
    cancelsEventId: row.cancels_event_id,
    stage: row.stage as FinancialStage,
    factDate: tryPlainDate(row.fact_date),
    budgetYear: row.budget_year,
    amendmentYear: row.amendment_year,
    amount: money(BigInt(Math.round(Number(row.amount_money) * 100)), 'BRL'),
    measure: row.measure as FinancialEvent['measure'],
    linkConfirmed: row.link_confirmed,
    reconciliationState: row.reconciliation_state as FinancialEvent['reconciliationState'],
    duplicateOfId: row.duplicate_of_id,
    evidenceIds: row.evidence_ids,
    accessClass: row.access_class as AccessClass,
    isSynthetic: row.is_synthetic,
  }));
}

/** Relacoes tipadas por entidade. Alimenta a checagem de autoria do validador. */
export async function getRelationTypesBySubject(
  db: QueryRunner,
  entityIds: readonly string[],
): Promise<Map<string, RelationType[]>> {
  if (entityIds.length === 0) return new Map();
  const r = await db.query<{ related_entity_id: string; relation_type: string }>(
    `select related_entity_id, relation_type::text as relation_type
       from ma.person_relations
      where related_entity_id = any($1::uuid[])
        and validation_state in ('auto_validated','human_reviewed','published')`,
    [entityIds],
  );
  const out = new Map<string, RelationType[]>();
  for (const row of r.rows) {
    const list = out.get(row.related_entity_id) ?? [];
    list.push(row.relation_type as RelationType);
    out.set(row.related_entity_id, list);
  }
  return out;
}

export async function getPersonRelations(
  db: QueryRunner,
  personId: string,
): Promise<
  {
    readonly relationType: RelationType;
    readonly relatedEntityId: string;
    readonly relatedEntityName: string;
    readonly relatedEntityKind: EntityKind;
    readonly roleAtDate: string | null;
    readonly validFrom: PlainDate | null;
    readonly validTo: PlainDate | null;
    readonly documentedShare: string | null;
    readonly matchMethod: string;
    readonly validationState: ValidationState;
    readonly evidenceIds: readonly string[];
  }[]
> {
  const r = await db.query<{
    relation_type: string; related_entity_id: string; official_name: string; kind: string;
    role_at_date: string | null; valid_from: string | null; valid_to: string | null;
    documented_share_money: string | null; match_method: string; validation_state: string;
    evidence_ids: string[];
  }>(
    `select pr.relation_type::text as relation_type, pr.related_entity_id,
            e.official_name, e.kind::text as kind, pr.role_at_date,
            pr.valid_from::text as valid_from, pr.valid_to::text as valid_to,
            pr.documented_share_money::text as documented_share_money,
            pr.match_method, pr.validation_state::text as validation_state, pr.evidence_ids
       from ma.person_relations pr
       join ma.entities e on e.id = pr.related_entity_id
      where pr.person_id = $1
      order by pr.relation_type, e.official_name`,
    [personId],
  );
  return r.rows.map((row) => ({
    relationType: row.relation_type as RelationType,
    relatedEntityId: row.related_entity_id,
    relatedEntityName: row.official_name,
    relatedEntityKind: row.kind as EntityKind,
    roleAtDate: row.role_at_date,
    validFrom: tryPlainDate(row.valid_from),
    validTo: tryPlainDate(row.valid_to),
    documentedShare: row.documented_share_money,
    matchMethod: row.match_method,
    validationState: row.validation_state as ValidationState,
    evidenceIds: row.evidence_ids,
  }));
}

/**
 * Linha do tempo (6.3 / T05 / T06): data do evento SEPARADA da data de
 * publicacao. Uma noticia publicada hoje sobre contrato antigo aparece com as
 * duas datas, nunca como contratacao de hoje.
 */
export async function getTimeline(db: QueryRunner, subjectId: string): Promise<TimelineItem[]> {
  const r = await db.query<{
    fact_date: string | null;
    publication_date: string | null;
    title: string;
    nature: string;
    evidence_ids: string[];
  }>(
    `select c.fact_date::text as fact_date,
            d.publication_date::text as publication_date,
            d.title_original as title,
            c.predicate as nature,
            coalesce(array_agg(ce.evidence_id) filter (where ce.evidence_id is not null), '{}') as evidence_ids
       from ma.claims c
       join ma.claim_evidence ce on ce.claim_id = c.id
       join ma.evidence ev on ev.id = ce.evidence_id
       join ma.document_versions d on d.id = ev.document_version_id
      where c.subject_id = $1 and c.retired_at is null
      group by c.fact_date, d.publication_date, d.title_original, c.predicate
      order by c.fact_date desc nulls last, d.publication_date desc nulls last`,
    [subjectId],
  );
  return r.rows.map((row) => ({
    factDate: tryPlainDate(row.fact_date),
    publicationDate: tryPlainDate(row.publication_date),
    title: row.title,
    relationNature: row.nature,
    evidenceIds: row.evidence_ids,
  }));
}

export async function getGaps(db: QueryRunner, subjectId: string): Promise<string[]> {
  const r = await db.query<{ missing_field: string; concrete_question: string; organ: string | null }>(
    `select g.missing_field, g.concrete_question, o.name as organ
       from ma.gaps g
       left join ma.organs o on o.id = g.competent_organ_id
      where g.subject_id = $1 and g.state <> 'closed'
      order by g.created_at`,
    [subjectId],
  );
  return r.rows.map((row) =>
    row.organ === null
      ? `${row.missing_field}: ${row.concrete_question}`
      : `${row.missing_field}: ${row.concrete_question} (unidade possivelmente competente: ${row.organ})`,
  );
}

export async function getConflicts(db: QueryRunner, subjectId: string): Promise<string[]> {
  const r = await db.query<{ predicate: string; difference_description: string; precedence_rule: string | null }>(
    `select predicate, difference_description, precedence_rule
       from ma.conflicts
      where subject_id = $1 and state = 'open'`,
    [subjectId],
  );
  return r.rows.map((row) =>
    `${row.predicate}: ${row.difference_description}` +
    (row.precedence_rule === null ? ' (sem criterio de prevalencia documentado)' : ` (criterio: ${row.precedence_rule})`),
  );
}

/**
 * 14.4: "A frase 'sem novidades' exige coleta bem-sucedida e comparacao
 * valida." Devolve null quando nao houve coleta bem-sucedida.
 */
export async function getLastSuccessfulCollection(db: QueryRunner): Promise<string | null> {
  const r = await db.query<{ last_success_at: string | null }>(
    `select max(last_success_at)::text as last_success_at from ma.source_datasets`,
  );
  return r.rows[0]?.last_success_at ?? null;
}

export interface CoverageRow {
  readonly sourceCode: string;
  readonly datasetName: string;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly staleAfterHours: number;
  readonly stale: boolean;
  readonly integrationStatus: string;
  readonly knownLimitations: readonly string[];
  /** Uma coleta de fixture nao conta como conector em operacao (§14.2). */
  readonly liveConnector: boolean;
}

/** 7.9 / 12: cobertura, falhas e defasagem visiveis. */
export async function getCoverage(db: QueryRunner): Promise<CoverageRow[]> {
  const r = await db.query<{
    code: string; name: string; last_success_at: string | null; last_attempt_at: string | null;
    stale_after_hours: number; integration_status: string; known_limitations: string[];
    enabled: boolean;
  }>(
    `select s.code, sd.name, sd.last_success_at::text as last_success_at,
            sd.last_attempt_at::text as last_attempt_at, sd.stale_after_hours,
            s.integration_status, s.known_limitations, s.enabled
       from ma.source_datasets sd
       join ma.sources s on s.id = sd.source_id
      order by s.code, sd.name`,
  );
  const nowMs = Date.now();
  return r.rows.map((row) => ({
    sourceCode: row.code,
    datasetName: row.name,
    lastSuccessAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    staleAfterHours: row.stale_after_hours,
    stale:
      row.last_success_at === null ||
      nowMs - Date.parse(row.last_success_at) > row.stale_after_hours * 3_600_000,
    integrationStatus: row.integration_status,
    knownLimitations: row.known_limitations,
    liveConnector: row.enabled && row.integration_status === 'connector_verified',
  }));
}

export interface RecentCard {
  readonly subjectId: string | null;
  readonly subjectName: string;
  readonly title: string;
  readonly area: string | null;
  readonly factDate: PlainDate | null;
  readonly publicationDate: PlainDate | null;
  readonly state: EvidenceState;
  readonly evidenceIds: readonly string[];
  readonly isSynthetic: boolean;
}

/**
 * Feed (6.3 / 7.3). Agrupa por assunto + evento para nao repetir cartoes do
 * mesmo fato, e devolve as duas datas separadas.
 */
export async function getRecentCards(
  db: QueryRunner,
  period: DateRange,
  limit = 5,
): Promise<RecentCard[]> {
  const r = await db.query<{
    subject_id: string | null; subject_name: string; title: string; area: string | null;
    fact_date: string | null; publication_date: string | null; state: string;
    evidence_ids: string[]; is_synthetic: boolean;
  }>(
    `select c.subject_id, e.official_name as subject_name,
            min(d.title_original) as title, e.area,
            c.fact_date::text as fact_date,
            max(d.publication_date)::text as publication_date,
            c.state::text as state,
            coalesce(array_agg(distinct ce.evidence_id), '{}') as evidence_ids,
            bool_or(d.is_synthetic) as is_synthetic
       from ma.claims c
       join ma.entities e on e.id = c.subject_id
       join ma.claim_evidence ce on ce.claim_id = c.id
       join ma.evidence ev on ev.id = ce.evidence_id
       join ma.document_versions d on d.id = ev.document_version_id
      where c.retired_at is null
        and c.validation_state in ('auto_validated','human_reviewed','published')
        and coalesce(c.fact_date, d.publication_date) between $1::date and $2::date
      group by c.subject_id, e.official_name, e.area, c.fact_date, c.state
      order by coalesce(c.fact_date, max(d.publication_date)) desc
      limit $3`,
    [period.from, period.to, limit],
  );
  return r.rows.map((row) => ({
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    title: row.title,
    area: row.area,
    factDate: tryPlainDate(row.fact_date),
    publicationDate: tryPlainDate(row.publication_date),
    state: row.state as EvidenceState,
    evidenceIds: row.evidence_ids,
    isSynthetic: row.is_synthetic,
  }));
}

export { plainDate };
