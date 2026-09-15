/** Coleta e promove as emendas do portal municipal de Várzea Grande (F03). */
import { closePool, withContext, type QueryRunner } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { fetchGuarded } from '../../../packages/connectors/src/http.ts';
import {
  PORTAL_EMENDAS_URL,
  linksDeEmendas,
  paginasDeEmendas,
  parseEmendaVg,
  textoDaEmenda,
  totalDeEmendas,
  type EmendaVg,
} from '../../../packages/connectors/src/emendas-vg.ts';
import { ingestBatch, type RawRecord } from './pipeline.ts';

const SOURCE_CODE = 'F03';
const DATASET = 'emendas';
const PARSER_VERSION = 'emendas-vg/1.0.0';
const login = process.env['INGESTION_LOGIN'] ?? 'admin.implantacao';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'varzea-grande';

async function getHtml(url: string): Promise<string> {
  const response = await fetchGuarded(url, { maxRetries: 2, maxBytes: 4 * 1024 * 1024 });
  return response.body.toString('utf8');
}

async function collect(): Promise<{ amendments: EmendaVg[]; expected: number | null }> {
  const first = await getHtml(PORTAL_EMENDAS_URL);
  const expected = totalDeEmendas(first);
  const pages = paginasDeEmendas(first);
  const links = new Set(linksDeEmendas(first));

  for (let page = 2; page <= pages; page += 1) {
    const url = new URL(PORTAL_EMENDAS_URL);
    url.searchParams.set('page', String(page));
    const html = await getHtml(url.toString());
    for (const link of linksDeEmendas(html)) links.add(link);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (expected !== null && links.size !== expected) {
    throw new Error(`portal declarou ${expected} emendas, mas a listagem revelou ${links.size} links`);
  }

  const amendments: EmendaVg[] = [];
  const allLinks = [...links];
  // Pequenos lotes paralelos evitam uma primeira carga de muitos minutos sem
  // transformar o portal público em alvo de rajada.
  for (let offset = 0; offset < allLinks.length; offset += 6) {
    const batch = allLinks.slice(offset, offset + 6);
    amendments.push(...await Promise.all(batch.map(async (link) =>
      parseEmendaVg(await getHtml(link), link))));
    if (offset + 6 < allLinks.length) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { amendments, expected };
}

function rawRecord(amendment: EmendaVg): RawRecord {
  return {
    externalId: amendment.id,
    documentType: 'amendment',
    title: `Emenda ${amendment.codigo} — ${amendment.objeto}`,
    issuingOrgan: 'Prefeitura Municipal de Várzea Grande',
    numberOriginal: amendment.codigo,
    fiscalYear: amendment.exercicio,
    urlOriginal: amendment.url,
    urlFinal: amendment.url,
    publicationDate: null,
    signatureDate: null,
    referenceDate: amendment.atualizadoEm,
    mimeType: 'text/html',
    textContent: textoDaEmenda(amendment),
    extractionMethod: 'html',
    extractionQuality: 'high',
    queryParameters: null,
    isSynthetic: false,
  };
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

interface ClaimValue {
  readonly predicate: string;
  readonly valueType: 'text' | 'integer' | 'money' | 'date';
  readonly text?: string;
  readonly integer?: number;
  readonly money?: string;
  readonly date?: string;
  readonly qualifiers?: Readonly<Record<string, unknown>>;
}

function claimsFor(a: EmendaVg): ClaimValue[] {
  const claims: Array<ClaimValue | null> = [
    { predicate: 'amendment_code', valueType: 'text', text: a.codigo },
    { predicate: 'budget_year', valueType: 'integer', integer: a.exercicio },
    { predicate: 'status', valueType: 'text', text: a.status },
    { predicate: 'sphere', valueType: 'text', text: a.esfera },
    { predicate: 'object', valueType: 'text', text: a.objeto },
    a.tipo === null ? null : { predicate: 'amendment_type', valueType: 'text', text: a.tipo },
    a.formaRepasse === null ? null : { predicate: 'transfer_method', valueType: 'text', text: a.formaRepasse },
    a.parlamentar === null ? null : {
      predicate: 'authorship', valueType: 'text', text: a.parlamentar,
      qualifiers: { partido: a.partido, esfera: a.esfera, conforme_identificacao_do_portal: true },
    },
    a.orgaoExecutor === null ? null : { predicate: 'responsible_organ', valueType: 'text', text: a.orgaoExecutor },
    a.valorOrcado === null ? null : {
      predicate: 'authorized_amount', valueType: 'money', money: a.valorOrcado,
      qualifiers: { estagio: 'valor orçado informado pelo portal' },
    },
    a.valorEmpenhado === null ? null : {
      predicate: 'committed_amount', valueType: 'money', money: a.valorEmpenhado,
      qualifiers: { estagio: 'valor empenhado informado pelo portal' },
    },
    a.valorPago === null ? null : {
      predicate: 'paid_amount', valueType: 'money', money: a.valorPago,
      qualifiers: { estagio: 'valor pago informado pelo portal' },
    },
    a.atualizadoEm === null ? null : { predicate: 'source_updated_at', valueType: 'date', date: a.atualizadoEm },
  ];
  return claims.filter((claim): claim is ClaimValue => claim !== null);
}

async function evidenceFor(db: QueryRunner, context: AuthorizedContext, amendment: EmendaVg): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `select ev.id
       from ma.evidence ev
       join ma.document_versions d on d.id = ev.document_version_id
       join ma.sources s on s.id = d.source_id
      where d.tenant_id = $1 and s.code = $2 and d.external_id = $3
      order by d.record_version desc, ev.obtained_at desc limit 1`,
    [context.tenantId, SOURCE_CODE, amendment.id],
  );
  const found = existing.rows[0]?.id;
  if (found !== undefined) return found;

  const document = await db.query<{ id: string; text_content: string }>(
    `select d.id, d.text_content
       from ma.document_versions d join ma.sources s on s.id = d.source_id
      where d.tenant_id = $1 and s.code = $2 and d.external_id = $3
      order by d.record_version desc limit 1`,
    [context.tenantId, SOURCE_CODE, amendment.id],
  );
  const row = document.rows[0];
  if (row === undefined) throw new Error(`documento ausente para emenda ${amendment.id}`);
  const inserted = await db.query<{ id: string }>(
    `insert into ma.evidence (tenant_id, document_version_id, locator, snippet, query_parameters)
     values ($1,$2,$3,$4,$5::jsonb) returning id`,
    [context.tenantId, row.id, amendment.url, row.text_content.slice(0, 1500), JSON.stringify({ portal_id: amendment.id })],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`falha ao criar evidencia da emenda ${amendment.id}`);
  return id;
}

async function promote(db: QueryRunner, context: AuthorizedContext, amendment: EmendaVg): Promise<void> {
  const evidenceId = await evidenceFor(db, context, amendment);
  const found = await db.query<{ id: string }>(
    `select id from ma.entities
      where tenant_id = $1 and kind = 'amendment'
        and external_ids ->> 'portal_emendas_vg' = $2 limit 1`,
    [context.tenantId, amendment.id],
  );
  let entityId = found.rows[0]?.id;
  const name = `Emenda ${amendment.codigo} — ${amendment.objeto}`;
  if (entityId === undefined) {
    const inserted = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, external_ids, area, is_synthetic)
       values ($1,$2,'amendment',$3,$4,$5::jsonb,$6,false) returning id`,
      [context.tenantId, context.municipalityId, name, normalize(name), JSON.stringify({
        portal_emendas_vg: amendment.id, codigo_emenda: amendment.codigo,
      }), amendment.orgaoExecutor],
    );
    entityId = inserted.rows[0]?.id;
  } else {
    await db.query(
      `update ma.entities set official_name = $3, name_normalized = $4,
              area = $5, external_ids = external_ids || $6::jsonb
        where tenant_id = $1 and id = $2`,
      [context.tenantId, entityId, name, normalize(name), amendment.orgaoExecutor,
        JSON.stringify({ codigo_emenda: amendment.codigo })],
    );
  }
  if (entityId === undefined) throw new Error(`falha ao criar entidade da emenda ${amendment.id}`);

  for (const claim of claimsFor(amendment)) {
    await db.query(
      `update ma.claims set retired_at = now()
        where tenant_id = $1 and subject_id = $2 and predicate = $3 and retired_at is null`,
      [context.tenantId, entityId, claim.predicate],
    );
    const inserted = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_numeric, value_money, currency,
          value_date, value_type, qualifiers, fact_date, state, validation_state, freshness_class,
          reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'documented','auto_validated',
               'mutable_operational',$12,$13,false) returning id`,
      [context.tenantId, entityId, claim.predicate, claim.text ?? null, claim.integer ?? null,
        claim.money ?? null, claim.money === undefined ? null : 'BRL', claim.date ?? null,
        claim.valueType, JSON.stringify(claim.qualifiers ?? {}), amendment.atualizadoEm,
        PARSER_VERSION, 'campo estruturado na página oficial da emenda'],
    );
    const claimId = inserted.rows[0]?.id;
    if (claimId === undefined) throw new Error('falha ao criar afirmacao');
    await db.query(
      `insert into ma.claim_evidence (claim_id, evidence_id, supports)
       values ($1,$2,'value') on conflict do nothing`,
      [claimId, evidenceId],
    );
  }

  const source = await db.query<{ id: string }>(
    `select id from ma.sources where tenant_id = $1 and code = $2`,
    [context.tenantId, SOURCE_CODE],
  );
  const sourceId = source.rows[0]?.id;
  if (sourceId === undefined) throw new Error('fonte F03 ausente');
  const events: Array<{ stage: 'indicated' | 'committed' | 'paid_supplier'; amount: string | null }> = [
    { stage: 'indicated', amount: amendment.valorOrcado },
    { stage: 'committed', amount: amendment.valorEmpenhado },
    { stage: 'paid_supplier', amount: amendment.valorPago },
  ];
  for (const event of events) {
    if (event.amount === null) continue;
    await db.query(
      `insert into ma.financial_events
         (tenant_id, source_id, external_id, instrument_id, stage, fact_date, budget_year,
          amendment_year, amount_money, currency, measure, link_confirmed, evidence_ids, is_synthetic)
       values ($1,$2,$3,$4,$5::ma.financial_stage,null,$6,$6,$7,'BRL','cumulative_position',true,
               array[$8]::uuid[],false)
       on conflict (tenant_id, source_id, external_id) do update
          set amount_money = excluded.amount_money, budget_year = excluded.budget_year,
              amendment_year = excluded.amendment_year, evidence_ids = excluded.evidence_ids`,
      [context.tenantId, sourceId, `${amendment.id}:${event.stage}`, entityId, event.stage,
        amendment.exercicio, event.amount, evidenceId],
    );
  }
}

process.env['INGESTION_ALLOWED_HOSTS'] ??= 'emendas.varzeagrande.mt.gov.br';
process.env['INGESTION_USER_AGENT'] ??= 'MeuAssessor/0.1 (coleta F03; portal municipal de emendas)';

const context = await contextFor(login, tenantSlug);
const { amendments, expected } = await collect();
console.log(`${amendments.length} emenda(s) encontrada(s); total declarado: ${expected ?? 'não informado'}.`);

const result = await withContext(context, async (db) => {
  const outcome = await ingestBatch(db, context, {
    sourceCode: SOURCE_CODE,
    datasetName: DATASET,
    requestedFrom: null,
    requestedTo: null,
    records: amendments.map(rawRecord),
    parserVersion: PARSER_VERSION,
    expectedCount: expected,
  });
  for (const amendment of amendments) await promote(db, context, amendment);
  const years = amendments.map((amendment) => amendment.exercicio);
  await db.query(
    `update ma.sources set integration_status = 'connector_verified', enabled = true,
            connector_version = $3, access_method = 'html',
            available_from = make_date($4,1,1), available_to = make_date($5,12,31),
            known_limitations = array['valores financeiros são posições acumuladas exibidas pelo portal; a data individual de cada evento não é publicada']
      where tenant_id = $1 and code = $2`,
    [context.tenantId, SOURCE_CODE, PARSER_VERSION, Math.min(...years), Math.max(...years)],
  );
  return outcome;
});

console.log(`F03 concluída: ${result.inserted} novo(s), ${result.newVersions} nova(s) versão(ões), ${result.unchanged} inalterado(s).`);
await closePool();
