/**
 * Coleta F07: enriquece as emendas já identificadas no acervo municipal com
 * dados financeiros e documentos relacionados publicados pela CGU.
 *
 * O universo e deliberadamente dirigido por identificadores oficiais já
 * conhecidos (F03/F10). A API da CGU nao oferece filtro por municipio; varrer
 * todas as emendas nacionais diariamente seria caro e impreciso para o piloto.
 */
import { closePool, withContext, type QueryRunner } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { fetchGuarded } from '../../../packages/connectors/src/http.ts';
import {
  parseDocumentosEmendaCgu,
  parseEmendasCgu,
  textoDocumentoEmendaCgu,
  textoEmendaCgu,
  urlDocumentosEmendaCgu,
  urlEmendasCgu,
  type DocumentoEmendaCgu,
  type EmendaCgu,
} from '../../../packages/connectors/src/cgu-emendas.ts';
import { ingestBatch, type RawRecord } from './pipeline.ts';

const SOURCE_CODE = 'F07';
const DATASET = 'emendas';
const PARSER_VERSION = 'cgu-emendas/1.0.0';
const PAGE_SIZE_OBSERVED = 15;
const MAX_DOCUMENT_PAGES = 100;

const login = process.env['INGESTION_LOGIN'] ?? 'admin.implantacao';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'varzea-grande';
const apiKey = process.env['PORTAL_TRANSPARENCIA_API_KEY'] ?? '';

interface Bundle {
  readonly emenda: EmendaCgu;
  readonly documentos: readonly DocumentoEmendaCgu[];
}

async function jsonCgu(url: string): Promise<unknown> {
  const response = await fetchGuarded(url, {
    maxRetries: 3,
    maxBytes: 8 * 1024 * 1024,
    headers: {
      'chave-api-dados': apiKey,
      accept: 'application/json',
    },
  });
  return JSON.parse(response.body.toString('utf8'));
}

async function codigosConhecidos(db: QueryRunner, context: AuthorizedContext): Promise<string[]> {
  const result = await db.query<{ codigo: string }>(
    `select distinct codigo
       from (
         select regexp_replace(x.value,'[^0-9]','','g') codigo
           from ma.entities e, lateral jsonb_each_text(e.external_ids) x
          where e.tenant_id=$1 and e.kind='amendment'
         union
         select regexp_replace(c.value_text,'[^0-9]','','g')
           from ma.claims c join ma.entities e on e.id=c.subject_id
          where e.tenant_id=$1 and e.kind='amendment'
            and c.predicate in ('amendment_code','transferegov_amendment_code','cgu_amendment_code')
            and c.retired_at is null
       ) q
      where codigo ~ '^20[0-9]{10}$'
      order by codigo`,
    [context.tenantId],
  );
  return result.rows.map((row) => row.codigo);
}

async function coletarDocumentos(codigo: string): Promise<DocumentoEmendaCgu[]> {
  const documentos: DocumentoEmendaCgu[] = [];
  const ids = new Set<string>();
  for (let pagina = 1; pagina <= MAX_DOCUMENT_PAGES; pagina += 1) {
    const lote = parseDocumentosEmendaCgu(await jsonCgu(urlDocumentosEmendaCgu(codigo, pagina)));
    let novos = 0;
    for (const documento of lote) {
      if (ids.has(documento.id)) continue;
      ids.add(documento.id);
      documentos.push(documento);
      novos += 1;
    }
    if (lote.length === 0 || lote.length < PAGE_SIZE_OBSERVED) return documentos;
    if (novos === 0) {
      throw new Error(`paginacao da CGU repetiu documentos da emenda ${codigo} na pagina ${pagina}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`emenda ${codigo} ultrapassou ${MAX_DOCUMENT_PAGES} paginas de documentos`);
}

async function coletar(codigos: readonly string[]): Promise<{ bundles: Bundle[]; ausentes: string[] }> {
  const bundles: Bundle[] = [];
  const ausentes: string[] = [];
  for (const codigo of codigos) {
    const lista = parseEmendasCgu(await jsonCgu(urlEmendasCgu(codigo)));
    const emenda = lista.find((item) => item.codigo === codigo);
    if (emenda === undefined) {
      ausentes.push(codigo);
      continue;
    }
    const documentos = await coletarDocumentos(codigo);
    bundles.push({ emenda, documentos });
    console.log(`CGU: emenda ${codigo}, ${documentos.length} documento(s) relacionado(s).`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { bundles, ausentes };
}

function tituloEmenda(e: EmendaCgu): string {
  return [
    `Emenda federal ${e.codigo}`,
    e.autor,
    e.localidade,
  ].filter((item): item is string => item !== null).join(' — ');
}

function registros(bundle: Bundle): RawRecord[] {
  const { emenda, documentos } = bundle;
  const url = urlEmendasCgu(emenda.codigo);
  const resumo: RawRecord = {
    externalId: `emenda:${emenda.codigo}`,
    documentType: 'amendment',
    title: tituloEmenda(emenda),
    issuingOrgan: 'Controladoria-Geral da União',
    numberOriginal: emenda.codigo,
    fiscalYear: emenda.ano,
    urlOriginal: url,
    urlFinal: url,
    publicationDate: null,
    signatureDate: null,
    referenceDate: null,
    mimeType: 'application/json',
    textContent: textoEmendaCgu(emenda, documentos.length),
    extractionMethod: 'structured',
    extractionQuality: 'high',
    queryParameters: { codigoEmenda: emenda.codigo, pagina: '1' },
    isSynthetic: false,
  };
  const detalhes = documentos.map((documento): RawRecord => {
    const documentoUrl = urlDocumentosEmendaCgu(emenda.codigo);
    return {
      externalId: `documento:${emenda.codigo}:${documento.id}`,
      documentType: 'financial_document',
      title: `${documento.fase ?? 'Documento'} ${documento.codigoResumido ?? documento.codigo} — emenda ${emenda.codigo}`,
      issuingOrgan: 'Governo Federal — documento relacionado pela CGU',
      numberOriginal: documento.codigo,
      fiscalYear: documento.data === null ? emenda.ano : Number(documento.data.slice(0, 4)),
      urlOriginal: documentoUrl,
      urlFinal: documentoUrl,
      publicationDate: null,
      signatureDate: null,
      referenceDate: documento.data,
      mimeType: 'application/json',
      textContent: textoDocumentoEmendaCgu(emenda.codigo, documento),
      extractionMethod: 'structured',
      extractionQuality: 'high',
      queryParameters: { codigoEmenda: emenda.codigo },
      isSynthetic: false,
    };
  });
  return [resumo, ...detalhes];
}

function normalizar(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function evidencia(
  db: QueryRunner,
  context: AuthorizedContext,
  externalId: string,
  locator: string,
  query: Readonly<Record<string, string>>,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `select ev.id
       from ma.evidence ev
       join ma.document_versions d on d.id=ev.document_version_id
       join ma.sources s on s.id=d.source_id and s.tenant_id=d.tenant_id
      where d.tenant_id=$1 and s.code=$2 and d.external_id=$3
      order by d.record_version desc,ev.obtained_at desc limit 1`,
    [context.tenantId, SOURCE_CODE, externalId],
  );
  const found = existing.rows[0]?.id;
  if (found !== undefined) return found;

  const document = await db.query<{ id: string; text_content: string }>(
    `select d.id,d.text_content
       from ma.document_versions d
       join ma.sources s on s.id=d.source_id and s.tenant_id=d.tenant_id
      where d.tenant_id=$1 and s.code=$2 and d.external_id=$3
      order by d.record_version desc limit 1`,
    [context.tenantId, SOURCE_CODE, externalId],
  );
  const row = document.rows[0];
  if (row === undefined) throw new Error(`documento F07 ausente: ${externalId}`);
  const inserted = await db.query<{ id: string }>(
    `insert into ma.evidence
       (tenant_id,document_version_id,locator,snippet,query_parameters)
     values ($1,$2,$3,$4,$5::jsonb) returning id`,
    [context.tenantId, row.id, locator, row.text_content.slice(0, 1500), JSON.stringify(query)],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`falha ao criar evidencia F07: ${externalId}`);
  return id;
}

interface Claim {
  readonly predicate: string;
  readonly valueType: 'text' | 'integer' | 'money';
  readonly text?: string | null;
  readonly integer?: number | null;
  readonly money?: string | null;
  readonly qualifiers?: Readonly<Record<string, unknown>>;
}

function claims(bundle: Bundle): Claim[] {
  const e = bundle.emenda;
  const lista: Claim[] = [
    { predicate: 'cgu_amendment_code', valueType: 'text', text: e.codigo },
    { predicate: 'cgu_budget_year', valueType: 'integer', integer: e.ano },
    { predicate: 'cgu_amendment_type', valueType: 'text', text: e.tipo },
    { predicate: 'cgu_author', valueType: 'text', text: e.autor },
    { predicate: 'cgu_locality', valueType: 'text', text: e.localidade },
    { predicate: 'cgu_function', valueType: 'text', text: e.funcao },
    { predicate: 'cgu_subfunction', valueType: 'text', text: e.subfuncao },
    {
      predicate: 'cgu_committed_amount', valueType: 'money', money: e.valorEmpenhado,
      qualifiers: { estagio: 'empenhado; posição acumulada da CGU' },
    },
    {
      predicate: 'cgu_liquidated_amount', valueType: 'money', money: e.valorLiquidado,
      qualifiers: { estagio: 'liquidado; posição acumulada da CGU' },
    },
    {
      predicate: 'cgu_paid_amount', valueType: 'money', money: e.valorPago,
      qualifiers: { estagio: 'pago pela União; posição acumulada da CGU' },
    },
    {
      predicate: 'cgu_outstanding_registered', valueType: 'money', money: e.valorRestoInscrito,
      qualifiers: { estagio: 'restos a pagar inscritos; posição acumulada da CGU' },
    },
    {
      predicate: 'cgu_outstanding_paid', valueType: 'money', money: e.valorRestoPago,
      qualifiers: { estagio: 'restos a pagar pagos; posição acumulada da CGU' },
    },
    {
      predicate: 'cgu_outstanding_cancelled', valueType: 'money', money: e.valorRestoCancelado,
      qualifiers: { estagio: 'restos a pagar cancelados; posição acumulada da CGU' },
    },
    { predicate: 'cgu_related_document_count', valueType: 'integer', integer: bundle.documentos.length },
  ];
  return lista.filter((claim) =>
    claim.valueType === 'text' ? claim.text !== null :
    claim.valueType === 'money' ? claim.money !== null :
    claim.integer !== null
  );
}

async function promover(db: QueryRunner, context: AuthorizedContext, bundle: Bundle): Promise<void> {
  const e = bundle.emenda;
  const evidenceId = await evidencia(
    db, context, `emenda:${e.codigo}`, urlEmendasCgu(e.codigo),
    { codigoEmenda: e.codigo, pagina: '1' },
  );

  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${context.tenantId}:cgu-emenda:${e.codigo}`,
  ]);
  const existing = await db.query<{ id: string }>(
    `select a.id
       from ma.entities a
      where a.tenant_id=$1 and a.kind='amendment'
        and exists (
          select 1 from jsonb_each_text(a.external_ids) x
           where regexp_replace(upper(x.value),'[^0-9A-Z]','','g')=$2
        )
      order by (a.external_ids ? 'portal_emendas_vg') desc,a.created_at
      limit 1`,
    [context.tenantId, e.codigo],
  );
  let entityId = existing.rows[0]?.id;
  const aliases = [e.codigo, e.autor, e.localidade].filter((v): v is string => v !== null);
  if (entityId === undefined) {
    const name = tituloEmenda(e);
    const inserted = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id,municipality_id,kind,official_name,name_normalized,aliases,external_ids,area,is_synthetic)
       values ($1,$2,'amendment',$3,$4,$5::text[],$6::jsonb,$7,false) returning id`,
      [context.tenantId, context.municipalityId, name, normalizar(name), aliases,
       JSON.stringify({ cgu_emenda: e.codigo, codigo_emenda: e.codigo }), e.funcao],
    );
    entityId = inserted.rows[0]?.id;
  } else {
    await db.query(
      `update ma.entities
          set external_ids=external_ids || jsonb_build_object('cgu_emenda',$3::text),
              aliases=array(
                select distinct valor
                  from unnest(array_cat(coalesce(aliases,'{}'::text[]),$4::text[])) valor
                 where btrim(valor)<>''
              ),
              area=coalesce(area,$5)
        where tenant_id=$1 and id=$2`,
      [context.tenantId, entityId, e.codigo, aliases, e.funcao],
    );
  }
  if (entityId === undefined) throw new Error(`falha ao resolver entidade da emenda ${e.codigo}`);

  for (const claim of claims(bundle)) {
    await db.query(
      `update ma.claims set retired_at=now()
        where tenant_id=$1 and subject_id=$2 and predicate=$3 and retired_at is null`,
      [context.tenantId, entityId, claim.predicate],
    );
    const inserted = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id,subject_id,predicate,value_text,value_numeric,value_money,currency,
          value_type,qualifiers,fact_date,state,validation_state,freshness_class,
          reviewed_by,review_method,is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,null,'documented','auto_validated',
               'mutable_operational',$10,$11,false) returning id`,
      [context.tenantId, entityId, claim.predicate, claim.text ?? null, claim.integer ?? null,
       claim.money ?? null, claim.money == null ? null : 'BRL', claim.valueType,
       JSON.stringify(claim.qualifiers ?? {}), PARSER_VERSION,
       'campo estruturado na API oficial da CGU'],
    );
    const claimId = inserted.rows[0]?.id;
    if (claimId === undefined) throw new Error('falha ao criar afirmacao F07');
    await db.query(
      `insert into ma.claim_evidence (claim_id,evidence_id,supports)
       values ($1,$2,'value') on conflict do nothing`,
      [claimId, evidenceId],
    );
  }

  for (const documento of bundle.documentos) {
    await evidencia(
      db, context, `documento:${e.codigo}:${documento.id}`,
      urlDocumentosEmendaCgu(e.codigo),
      { codigoEmenda: e.codigo },
    );
  }

  const source = await db.query<{ id: string }>(
    'select id from ma.sources where tenant_id=$1 and code=$2',
    [context.tenantId, SOURCE_CODE],
  );
  const sourceId = source.rows[0]?.id;
  if (sourceId === undefined) throw new Error('fonte F07 ausente');

  const eventos: Array<{ stage: 'committed' | 'liquidated' | 'paid_supplier'; amount: string | null }> = [
    { stage: 'committed', amount: e.valorEmpenhado },
    { stage: 'liquidated', amount: e.valorLiquidado },
    { stage: 'paid_supplier', amount: e.valorPago },
  ];
  for (const evento of eventos) {
    if (evento.amount === null) continue;
    await db.query(
      `insert into ma.financial_events
         (tenant_id,source_id,external_id,instrument_id,stage,fact_date,budget_year,
          amendment_year,amount_money,currency,measure,link_confirmed,evidence_ids,is_synthetic)
       values ($1,$2,$3,$4,$5::ma.financial_stage,null,$6,$6,$7,'BRL',
               'cumulative_position',true,array[$8]::uuid[],false)
       on conflict (tenant_id,source_id,external_id) do update
          set instrument_id=excluded.instrument_id,amount_money=excluded.amount_money,
              budget_year=excluded.budget_year,amendment_year=excluded.amendment_year,
              evidence_ids=excluded.evidence_ids`,
      [context.tenantId, sourceId, `${e.codigo}:${evento.stage}:cumulative`,
       entityId, evento.stage, e.ano, evento.amount, evidenceId],
    );
  }
}

if (apiKey === '') {
  console.error('PORTAL_TRANSPARENCIA_API_KEY nao esta configurada.');
  process.exit(1);
}

process.env['INGESTION_ALLOWED_HOSTS'] ??= 'api.portaldatransparencia.gov.br';
process.env['INGESTION_USER_AGENT'] ??=
  'MeuAssessor/0.1 (coleta de emendas federais; +https://github.com/cardapio-ditado/meu-assessor)';

const context = await contextFor(login, tenantSlug);
const codigos = await withContext(context, (db) => codigosConhecidos(db, context));
if (codigos.length === 0) {
  console.error('Nenhum codigo federal de 12 digitos foi encontrado em F03/F10.');
  await closePool();
  process.exit(1);
}
console.log(`Consultando a CGU para ${codigos.length} codigo(s) oficial(is) conhecido(s).`);

const { bundles, ausentes } = await coletar(codigos);
if (bundles.length === 0) {
  console.error('A CGU nao devolveu nenhuma das emendas conhecidas; coleta rejeitada.');
  await closePool();
  process.exit(1);
}
if (ausentes.length > 0) {
  console.warn(`Sem correspondencia na CGU: ${ausentes.join(', ')}.`);
}

const result = await withContext(context, async (db) => {
  const records = bundles.flatMap(registros);
  const outcome = await ingestBatch(db, context, {
    sourceCode: SOURCE_CODE,
    datasetName: DATASET,
    requestedFrom: null,
    requestedTo: null,
    records,
    parserVersion: PARSER_VERSION,
    expectedCount: null,
  });
  for (const bundle of bundles) await promover(db, context, bundle);

  const years = bundles.map((bundle) => bundle.emenda.ano);
  await db.query(
    `update ma.sources
        set integration_status='connector_verified',enabled=true,connector_version=$3,
            access_method='api',available_from=make_date($4,1,1),available_to=make_date($5,12,31),
            known_limitations=array[
              'a API da CGU nao oferece filtro por municipio; a coleta enriquece codigos oficiais identificados por F03 e F10',
              'valores financeiros sao posicoes acumuladas e nao devem ser somados entre atualizacoes ou fontes sem conciliacao',
              'a API exige token mantido somente em segredo do GitHub Actions'
            ]
      where tenant_id=$1 and code=$2`,
    [context.tenantId, SOURCE_CODE, PARSER_VERSION, Math.min(...years), Math.max(...years)],
  );
  return { outcome, records: records.length };
});

console.log(
  `F07 concluida: ${bundles.length} emenda(s), ${result.records - bundles.length} documento(s); ` +
  `${result.outcome.inserted} novo(s), ${result.outcome.newVersions} nova(s) versao(oes), ` +
  `${result.outcome.unchanged} inalterado(s).`,
);
await closePool();
