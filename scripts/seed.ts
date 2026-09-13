/**
 * Carga do recorte sintetico de demonstracao (E2 - cadeia vertical).
 *
 * Briefing 1.2: "Dados ficticios somente em demonstracao e testes,
 * identificados e separados dos dados reais." Todo registro criado aqui recebe
 * is_synthetic = true, e as fontes ficam com enabled = false: a carga nao
 * habilita nenhum conector.
 *
 * Uso: DATABASE_URL=... node --experimental-strip-types scripts/seed.ts [--reset]
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, withoutTenant, type QueryRunner } from '../packages/db/src/pool.ts';
import { SOURCE_CATALOG } from '../packages/connectors/src/catalog.ts';
import { ingestBatch, type RawRecord } from '../workers/ingestion/src/pipeline.ts';
import { withContext } from '../packages/db/src/pool.ts';
import type { AuthorizedContext } from '../packages/domain/src/types.ts';
import { normalizeForSearch } from '../packages/retrieval/src/search.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'synthetic', 'recorte-piloto.json');

interface Fixture {
  municipio: { nome: string; uf: string; fuso: string };
  localidades: { ref: string; nome: string; aliases: string[]; tipo: string }[];
  orgaos: { ref: string; nome: string; sigla: string; tipo: string; vigencia_inicio: string }[];
  pessoas: { ref: string; nome: string; aliases: string[]; cargo: string; esfera: string }[];
  assuntos: { ref: string; nome: string; aliases: string[]; localidade: string; area: string; orgao: string }[];
  instrumentos: { ref: string; kind: string; nome: string; identificadores: Record<string, string> }[];
  contratos: {
    ref: string; numero: string; objeto: string; fornecedor: string; assunto: string;
    valor_contratado: string; vigencia_inicio: string; vigencia_fim_original: string;
  }[];
  documentos: {
    ref: string; fonte: string; conjunto: string; external_id: string; tipo: string;
    titulo: string; orgao: string | null; numero: string | null; exercicio: number | null;
    publicacao: string | null; assinatura: string | null; metodo: string; qualidade: string; texto: string;
  }[];
  eventos_financeiros: {
    ref: string; fonte: string; external_id: string; etapa: string; valor: string; data: string;
    instrumento?: string; assunto?: string; destinatario?: string | null;
    medida: string; documento_financeiro: string | null; vinculo_confirmado: boolean; evidencia: string;
    cancela?: string;
  }[];
}

const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;

const TENANT_SLUG = 'demonstracao';
const USER_LOGIN = 'gestor.demo';
const CURATOR_LOGIN = 'curador.demo';
/** Segunda organizacao, usada apenas pelos testes de isolamento (E5 / T33). */
const OTHER_TENANT_SLUG = 'demonstracao-vizinha';

/**
 * Limpeza de desenvolvimento. A ordem e explicita de proposito: ma.evidence
 * tem `on delete restrict` vindo de ma.claim_evidence, para que uma evidencia
 * nunca desapareca debaixo de uma afirmacao que a cita (12.1). Confiar no
 * cascade faria o reset esbarrar nessa protecao — que e justamente o
 * comportamento desejado em producao.
 */
if (process.argv.includes('--reset')) {
  // Os tenants nao tem RLS (sao consultados antes de existir contexto), mas
  // TODAS as tabelas de conteudo tem. Por isso a limpeza roda dentro do
  // contexto de cada organizacao: sem isso os deletes seriam no-op e o cascade
  // final esbarraria no `on delete restrict` de ma.evidence.
  const tenantIds = await withoutTenant(async (db) => {
    const r = await db.query<{ id: string }>(
      `select id from ma.tenants where slug = any($1::text[])`,
      [[TENANT_SLUG, OTHER_TENANT_SLUG]],
    );
    return r.rows.map((row) => row.id);
  });

  for (const tenantId of tenantIds) {
    const wipeContext: AuthorizedContext = {
      userId: '00000000-0000-0000-0000-000000000000',
      tenantId,
      tenantSlug: 'reset',
      municipalityId: '00000000-0000-0000-0000-000000000000',
      municipalityName: 'reset',
      timeZone: 'UTC',
      roles: ['platform_ops'],
      // Todas as classes: a limpeza precisa alcancar tambem registros
      // restritos desta organizacao.
      accessClasses: ['public', 'internal_authorized', 'restricted', 'blocked'],
    };
    await withContext(wipeContext, async (db) => {
      await db.query(
        `delete from ma.claim_evidence
          where claim_id in (select id from ma.claims where tenant_id = $1)`,
        [tenantId],
      );
      for (const table of [
        'answer_cache', 'answers', 'review_queue', 'conflicts', 'gaps',
        'financial_events', 'chain_links', 'person_relations', 'claims',
        'entity_matches', 'evidence', 'coverage_matrix', 'source_runs',
        'document_versions', 'source_datasets', 'sources', 'entities',
        'localities', 'organs', 'research_jobs', 'audit_log',
        'user_grants', 'tenant_municipalities',
      ]) {
        await db.query(`delete from ma.${table} where tenant_id = $1`, [tenantId]);
      }
    });
  }

  await withoutTenant(async (db) => {
    if (tenantIds.length > 0) {
      await db.query(`delete from ma.tenants where id = any($1::uuid[])`, [tenantIds]);
    }
    await db.query(`delete from ma.users where login = any($1::text[])`, [
      [USER_LOGIN, CURATOR_LOGIN, 'gestor.vizinho'],
    ]);
    await db.query(`delete from ma.municipalities where name = any($1::text[])`, [
      [fixture.municipio.nome, 'Municipio Vizinho de Demonstracao'],
    ]);
  });
}

async function one<T extends Record<string, unknown>>(
  db: QueryRunner,
  sql: string,
  params: readonly unknown[],
): Promise<T> {
  const r = await db.query<T>(sql, params);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`consulta nao devolveu linha: ${sql.slice(0, 60)}`);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Organizacao, municipio e usuarios (sem contexto de tenant ainda)
// ---------------------------------------------------------------------------
const { context, otherContext, curatorId } = await withoutTenant(async (db) => {
  const municipality = await one<{ id: string }>(db,
    `insert into ma.municipalities (name, uf, time_zone)
     values ($1, $2, $3)
     on conflict (name, uf) do update set time_zone = excluded.time_zone
     returning id`,
    [fixture.municipio.nome, fixture.municipio.uf, fixture.municipio.fuso],
  );
  const neighbour = await one<{ id: string }>(db,
    `insert into ma.municipalities (name, uf, time_zone)
     values ('Municipio Vizinho de Demonstracao', 'MT', 'America/Cuiaba')
     on conflict (name, uf) do update set time_zone = excluded.time_zone
     returning id`,
    [],
  );

  const tenant = await one<{ id: string }>(db,
    `insert into ma.tenants (slug, display_name) values ($1, $2)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [TENANT_SLUG, 'Organizacao de demonstracao'],
  );
  const otherTenant = await one<{ id: string }>(db,
    `insert into ma.tenants (slug, display_name) values ($1, $2)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [OTHER_TENANT_SLUG, 'Organizacao vizinha (teste de isolamento)'],
  );

  // tenant_municipalities e user_grants tem RLS: a escrita precisa acontecer
  // dentro do contexto da propria organizacao. Isto nao e contorno, e a prova
  // de que a politica do 0005 vale tambem para o provisionamento (20.3).

  const user = await one<{ id: string }>(db,
    `insert into ma.users (login, display_name, job_title) values ($1, $2, $3)
     on conflict (login) do update set display_name = excluded.display_name returning id`,
    [USER_LOGIN, 'Gestor de demonstracao', 'Chefe do Executivo (ficticio)'],
  );
  const curator = await one<{ id: string }>(db,
    `insert into ma.users (login, display_name, job_title) values ($1, $2, $3)
     on conflict (login) do update set display_name = excluded.display_name returning id`,
    [CURATOR_LOGIN, 'Curador de demonstracao', 'Curadoria de dados'],
  );
  const neighbourUser = await one<{ id: string }>(db,
    `insert into ma.users (login, display_name, job_title) values ('gestor.vizinho', 'Gestor vizinho', 'Gabinete')
     on conflict (login) do update set display_name = excluded.display_name returning id`,
    [],
  );

  const build = (
    userId: string,
    tenantId: string,
    tenantSlug: string,
    municipalityId: string,
    name: string,
  ): AuthorizedContext => ({
    userId,
    tenantId,
    tenantSlug,
    municipalityId,
    municipalityName: name,
    timeZone: fixture.municipio.fuso,
    roles: ['manager'],
    accessClasses: ['public', 'internal_authorized'],
  });

  return {
    context: build(user.id, tenant.id, TENANT_SLUG, municipality.id, fixture.municipio.nome),
    otherContext: build(
      neighbourUser.id,
      otherTenant.id,
      OTHER_TENANT_SLUG,
      neighbour.id,
      'Municipio Vizinho de Demonstracao',
    ),
    curatorId: curator.id,
  };
});

// Provisionamento dentro do contexto de cada organizacao.
await withContext(context, async (db) => {
  await db.query(
    `insert into ma.tenant_municipalities (tenant_id, municipality_id) values ($1, $2)
     on conflict do nothing`,
    [context.tenantId, context.municipalityId],
  );
  await db.query(
    `insert into ma.user_grants (user_id, tenant_id, role, access_classes) values
       ($1, $2, 'manager', array['public','internal_authorized']::ma.access_class[]),
       ($3, $2, 'data_curator', array['public','internal_authorized']::ma.access_class[])
     on conflict (user_id, tenant_id, role) do nothing`,
    [context.userId, context.tenantId, curatorId],
  );
});
await withContext(otherContext, async (db) => {
  await db.query(
    `insert into ma.tenant_municipalities (tenant_id, municipality_id) values ($1, $2)
     on conflict do nothing`,
    [otherContext.tenantId, otherContext.municipalityId],
  );
  await db.query(
    `insert into ma.user_grants (user_id, tenant_id, role, access_classes) values
       ($1, $2, 'manager', array['public']::ma.access_class[])
     on conflict (user_id, tenant_id, role) do nothing`,
    [otherContext.userId, otherContext.tenantId],
  );
});

// ---------------------------------------------------------------------------
// 2. Catalogo de fontes: cadastrado com a situacao REAL de integracao,
//    e nenhuma fonte habilitada (8.4, C.2)
// ---------------------------------------------------------------------------
await withContext(context, async (db) => {
  for (const spec of SOURCE_CATALOG) {
    const source = await one<{ id: string }>(db,
      `insert into ma.sources
         (tenant_id, code, official_name, domain, organ, sphere, record_types, access_method,
          requires_credentials, desired_frequency, access_class, operational_owner,
          connector_version, known_limitations, integration_status, enabled)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'duas janelas diarias','public','operacao-nao-designada','0.1.0',$10,$11,false)
       on conflict (tenant_id, code) do update
          set official_name = excluded.official_name,
              integration_status = excluded.integration_status,
              known_limitations = excluded.known_limitations
       returning id`,
      [
        context.tenantId, spec.code, spec.officialName, spec.domain, spec.organ, spec.sphere,
        spec.recordTypes, spec.accessMethod, spec.requiresCredentials,
        spec.knownLimitations, spec.integrationStatus,
      ],
    );
    for (const dataset of spec.datasets) {
      await db.query(
        `insert into ma.source_datasets (tenant_id, source_id, name, record_type, cadence, stale_after_hours)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (source_id, name) do update set cadence = excluded.cadence`,
        [context.tenantId, source.id, dataset.name, dataset.recordType, dataset.cadence, dataset.staleAfterHours],
      );
    }
    // Registro da prova de acesso como auditoria, nao como integracao pronta.
    await db.query(
      `insert into ma.audit_log (tenant_id, actor, action, object_kind, object_id, detail)
       values ($1, 'seed', 'access_probe_recorded', 'source', $2, $3)`,
      [context.tenantId, spec.code, JSON.stringify({ probe: spec.probe, url: spec.url })],
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Documentos sinteticos pelo pipeline real de ingestao
// ---------------------------------------------------------------------------
const byDataset = new Map<string, typeof fixture.documentos>();
for (const doc of fixture.documentos) {
  const key = `${doc.fonte}/${doc.conjunto}`;
  const list = byDataset.get(key) ?? [];
  list.push(doc);
  byDataset.set(key, list);
}

const ingestSummary: string[] = [];
for (const [key, docs] of byDataset) {
  const [sourceCode = '', datasetName = ''] = key.split('/');
  const records: RawRecord[] = docs.map((doc) => ({
    externalId: doc.external_id,
    documentType: doc.tipo,
    title: doc.titulo,
    issuingOrgan: doc.orgao,
    numberOriginal: doc.numero,
    fiscalYear: doc.exercicio,
    urlOriginal: null,
    urlFinal: null,
    publicationDate: doc.publicacao,
    signatureDate: doc.assinatura,
    referenceDate: null,
    mimeType: 'text/plain',
    textContent: doc.texto,
    extractionMethod: doc.metodo as RawRecord['extractionMethod'],
    extractionQuality: doc.qualidade as RawRecord['extractionQuality'],
    queryParameters: null,
    isSynthetic: true,
  }));

  const outcome = await withContext(context, (db) =>
    ingestBatch(db, context, {
      sourceCode,
      datasetName,
      requestedFrom: '2025-01-01',
      requestedTo: '2026-09-12',
      records,
      parserVersion: 'fixture-loader/0.1.0',
      expectedCount: records.length,
    }),
  );
  ingestSummary.push(
    `${key}: ${outcome.inserted} novo(s), ${outcome.newVersions} nova(s) versao(oes), ` +
      `${outcome.unchanged} inalterado(s), ${outcome.quarantined} em quarentena ` +
      `(${outcome.injectionFindings} deteccao(oes) de instrucao embutida)`,
  );
}

// ---------------------------------------------------------------------------
// 4. Entidades, evidencias, afirmacoes, relacoes e eventos financeiros
// ---------------------------------------------------------------------------
await withContext(context, async (db) => {
  const localityIds = new Map<string, string>();
  for (const loc of fixture.localidades) {
    const row = await one<{ id: string }>(db,
      `insert into ma.localities (tenant_id, municipality_id, official_name, aliases, locality_type)
       values ($1,$2,$3,$4,$5) returning id`,
      [context.tenantId, context.municipalityId, loc.nome, loc.aliases, loc.tipo],
    );
    localityIds.set(loc.ref, row.id);
  }

  const organIds = new Map<string, string>();
  for (const organ of fixture.orgaos) {
    const row = await one<{ id: string }>(db,
      `insert into ma.organs (tenant_id, municipality_id, name, acronym, organ_type, valid_from)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [context.tenantId, context.municipalityId, organ.nome, organ.sigla, organ.tipo, organ.vigencia_inicio],
    );
    organIds.set(organ.ref, row.id);
  }

  const entityIds = new Map<string, string>();
  const insertEntity = async (
    ref: string,
    kind: string,
    name: string,
    aliases: readonly string[],
    externalIds: Record<string, string>,
    localityRef: string | null,
    organRef: string | null,
    area: string | null,
  ): Promise<string> => {
    const row = await one<{ id: string }>(db,
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, aliases,
          external_ids, locality_id, organ_id, area, is_synthetic)
       values ($1,$2,$3::ma.entity_kind,$4,$5,$6,$7::jsonb,$8,$9,$10,true) returning id`,
      [
        context.tenantId, context.municipalityId, kind, name, normalizeForSearch(name),
        aliases, JSON.stringify(externalIds),
        localityRef === null ? null : localityIds.get(localityRef) ?? null,
        organRef === null ? null : organIds.get(organRef) ?? null,
        area,
      ],
    );
    entityIds.set(ref, row.id);
    return row.id;
  };

  for (const organ of fixture.orgaos) {
    await insertEntity(`orgao:${organ.ref}`, 'organ', organ.nome, [organ.sigla], {}, null, organ.ref, null);
  }
  for (const person of fixture.pessoas) {
    await insertEntity(person.ref, 'public_person', person.nome, person.aliases, {}, null, null, person.cargo);
  }
  for (const subject of fixture.assuntos) {
    await insertEntity(
      subject.ref, 'subject', subject.nome, subject.aliases, {},
      subject.localidade, subject.orgao, subject.area,
    );
  }
  for (const instrument of fixture.instrumentos) {
    await insertEntity(
      instrument.ref, instrument.kind, instrument.nome, [], instrument.identificadores, null, null, null,
    );
  }
  for (const contract of fixture.contratos) {
    await insertEntity(
      contract.ref, 'contract', `Contrato ${contract.numero} - ${contract.objeto}`, [contract.numero],
      { sintetica: contract.numero }, null, null, null,
    );
  }
  // Fundo municipal como entidade destinataria (T10).
  const fundoId = entityIds.get('orgao:fundo-saude');
  if (fundoId === undefined) throw new Error('fundo de saude nao criado');

  // Evidencias, uma por documento, ancoradas no trecho relevante.
  const evidenceIds = new Map<string, string>();
  const docRows = await db.query<{ id: string; external_id: string; text_content: string }>(
    `select id, external_id, text_content from ma.document_versions where is_synthetic = true`,
  );
  const docByExternal = new Map(docRows.rows.map((r) => [r.external_id, r]));

  for (const doc of fixture.documentos) {
    const row = docByExternal.get(doc.external_id);
    if (row === undefined) continue; // documento em quarentena (T30): sem evidencia
    const snippet = row.text_content.slice(0, 320);
    const evidence = await one<{ id: string }>(db,
      `insert into ma.evidence (tenant_id, document_version_id, locator, snippet, query_parameters)
       values ($1,$2,$3,$4,$5::jsonb) returning id`,
      [context.tenantId, row.id, 'trecho 1 (fixture sintetica)', snippet, JSON.stringify({ fixture: doc.ref })],
    );
    evidenceIds.set(doc.ref, evidence.id);
  }

  const ev = (ref: string): string => {
    const id = evidenceIds.get(ref);
    if (id === undefined) throw new Error(`evidencia ausente para ${ref}`);
    return id;
  };
  const en = (ref: string): string => {
    const id = entityIds.get(ref);
    if (id === undefined) throw new Error(`entidade ausente para ${ref}`);
    return id;
  };

  interface ClaimSpec {
    subject: string;
    predicate: string;
    valueType: string;
    text?: string | null;
    date?: string | null;
    moneyValue?: string | null;
    state: string;
    validationState: string;
    freshness: string;
    factDate: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    nullReason?: string | null;
    evidence: string[];
    qualifiers?: Record<string, string>;
  }

  const claims: ClaimSpec[] = [
    // Quadra do Bairro Exemplo: contrato documentado, prazo em divergencia,
    // percentual fisico nao localizado.
    {
      subject: 'quadra-exemplo', predicate: 'contract_number', valueType: 'text',
      text: '045/2025', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2025-03-01',
      evidence: ['doc-diario-contrato-quadra'],
    },
    {
      subject: 'quadra-exemplo', predicate: 'contracted_amount', valueType: 'money',
      moneyValue: '800000.00', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2025-03-01',
      evidence: ['doc-diario-contrato-quadra'],
    },
    {
      subject: 'quadra-exemplo', predicate: 'supplier', valueType: 'text',
      text: 'Construtora Ficticia Alfa Ltda', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2025-03-01',
      evidence: ['doc-diario-contrato-quadra'],
    },
    // T16: vigencia aplicavel vem do aditivo; o original e preservado abaixo.
    {
      subject: 'quadra-exemplo', predicate: 'contract_validity_end', valueType: 'date',
      date: '2026-06-29', state: 'divergent', validationState: 'published',
      freshness: 'mutable_operational', factDate: '2025-11-20',
      validFrom: '2025-11-20', validTo: null,
      evidence: ['doc-diario-aditivo-quadra', 'doc-transparencia-prazo-divergente'],
      qualifiers: { origem: 'primeiro termo aditivo', conflito: 'ficha de transparencia informa 2025-12-31' },
    },
    {
      subject: 'quadra-exemplo', predicate: 'status', valueType: 'text',
      text: 'em execucao segundo comunicacao oficial', state: 'source_reported',
      validationState: 'published', freshness: 'mutable_operational', factDate: '2026-09-02',
      evidence: ['doc-noticia-quadra-antiga'],
    },
    {
      subject: 'quadra-exemplo', predicate: 'physical_progress', valueType: 'null',
      nullReason: 'nenhuma medicao ou boletim de execucao fisica localizado no recorte',
      state: 'not_located', validationState: 'published', freshness: 'undefined', factDate: null,
      evidence: ['doc-diario-contrato-quadra'],
    },
    // Reforma da UBS: 100% pago, sem medicao (T19), conclusao apenas informada (T18)
    {
      subject: 'ubs-modelo', predicate: 'contract_number', valueType: 'text',
      text: '112/2025', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2025-06-01',
      evidence: ['doc-pagamentos-ubs'],
    },
    {
      subject: 'ubs-modelo', predicate: 'contracted_amount', valueType: 'money',
      moneyValue: '500000.00', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2025-06-01',
      evidence: ['doc-pagamentos-ubs'],
    },
    {
      subject: 'ubs-modelo', predicate: 'status', valueType: 'text',
      text: 'entrega relatada por nota oficial, sem termo de recebimento localizado',
      state: 'source_reported', validationState: 'published',
      freshness: 'mutable_operational', factDate: '2026-09-05',
      evidence: ['doc-noticia-ubs-concluida'],
    },
    {
      subject: 'ubs-modelo', predicate: 'physical_progress', valueType: 'null',
      nullReason: 'pagamento integral nao comprova execucao fisica; nenhuma medicao localizada',
      state: 'not_located', validationState: 'published', freshness: 'undefined', factDate: null,
      evidence: ['doc-pagamentos-ubs'],
    },
    // Poco: assunto sem evidencia financeira (T24/T25)
    {
      subject: 'poco-amostra', predicate: 'status', valueType: 'null',
      nullReason: 'nenhum documento sobre este assunto no recorte do piloto',
      state: 'not_located', validationState: 'published', freshness: 'undefined', factDate: null,
      evidence: ['doc-diario-contrato-quadra'],
    },
    // Emenda coletiva
    {
      subject: 'emenda-coletiva-01', predicate: 'authorized_amount', valueType: 'money',
      moneyValue: '1000000.00', state: 'documented', validationState: 'published',
      freshness: 'stable_history', factDate: '2026-02-10',
      evidence: ['doc-emenda-coletiva'],
      qualifiers: { natureza: 'coletiva', parcela_individual: 'nao informada pela fonte' },
    },
  ];

  const claimIds: string[] = [];
  for (const spec of claims) {
    const row = await one<{ id: string }>(db,
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_date, value_money, currency,
          value_type, qualifiers, valid_from, valid_to, fact_date, state, validation_state,
          freshness_class, null_reason, reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,
               $13::ma.evidence_state,$14::ma.validation_state,$15::ma.freshness_class,$16,
               'seed','carga sintetica revisada manualmente',true)
       returning id`,
      [
        context.tenantId, en(spec.subject), spec.predicate, spec.text ?? null, spec.date ?? null,
        spec.moneyValue ?? null, spec.moneyValue == null ? null : 'BRL',
        spec.valueType, JSON.stringify(spec.qualifiers ?? {}),
        spec.validFrom ?? null, spec.validTo ?? null, spec.factDate,
        spec.state, spec.validationState, spec.freshness, spec.nullReason ?? null,
      ],
    );
    claimIds.push(row.id);
    for (const evidenceRef of spec.evidence) {
      await db.query(
        `insert into ma.claim_evidence (claim_id, evidence_id, supports) values ($1,$2,'value')
         on conflict do nothing`,
        [row.id, ev(evidenceRef)],
      );
    }
  }

  // T16: versao ORIGINAL do prazo, retirada mas preservada, para "qual era o
  // prazo em marco?" (T22) e para o historico.
  const original = await one<{ id: string }>(db,
    `insert into ma.claims
       (tenant_id, subject_id, predicate, value_date, value_type, fact_date,
        valid_from, valid_to, recorded_at, retired_at, state, validation_state, freshness_class,
        reviewed_by, review_method, is_synthetic)
     values ($1,$2,'contract_validity_end','2025-12-31','date','2025-03-01',
             '2025-03-01','2025-11-19','2025-03-05T12:00:00Z','2025-11-25T12:00:00Z',
             'documented','superseded','stable_history','seed','versao original preservada',true)
     returning id`,
    [context.tenantId, en('quadra-exemplo')],
  );
  await db.query(
    `insert into ma.claim_evidence (claim_id, evidence_id, supports) values ($1,$2,'period')`,
    [original.id, ev('doc-diario-contrato-quadra')],
  );

  // Conflito explicito de prazo (T20), com as duas versoes preservadas.
  const currentValidity = await one<{ id: string }>(db,
    `select id from ma.claims
      where subject_id = $1 and predicate = 'contract_validity_end' and retired_at is null limit 1`,
    [en('quadra-exemplo')],
  );
  await db.query(
    `insert into ma.conflicts
       (tenant_id, subject_id, predicate, claim_a_id, claim_b_id, same_object, same_period,
        same_stage, difference_description, precedence_rule)
     values ($1,$2,'contract_validity_end',$3,$4,true,true,true,$5,$6)`,
    [
      context.tenantId, en('quadra-exemplo'), currentValidity.id, original.id,
      'O primeiro termo aditivo publicado no diario registra termo final em 29/06/2026; a ficha do portal de transparencia ainda informa 31/12/2025.',
      'ato posterior especifico sobre vigencia prevalece sobre ficha nao datada, sujeito a revisao humana',
    ],
  );

  // Lacunas visiveis (7.6, 9.4)
  await db.query(
    `insert into ma.gaps (tenant_id, subject_id, missing_field, concrete_question, competent_organ_id, authorized_channel)
     values
       ($1,$2,'physical_progress','Existe boletim de medicao ou termo de recebimento da quadra do Bairro Exemplo em 2026?',$3,'canal institucional a cadastrar'),
       ($1,$4,'physical_progress','Existe termo de recebimento definitivo da reforma da UBS do Bairro Modelo?',$5,'canal institucional a cadastrar'),
       ($1,$6,'status','Existe qualquer documento administrativo sobre o poco artesiano do Distrito Amostra?',$5,'canal institucional a cadastrar')`,
    [
      context.tenantId, en('quadra-exemplo'), organIds.get('sec-obras') ?? null,
      en('ubs-modelo'), organIds.get('fundo-saude') ?? null, en('poco-amostra'),
    ],
  );

  // Relacoes de agentes publicos (11.2 / T08 / T09)
  await db.query(
    `insert into ma.person_relations
       (tenant_id, person_id, related_entity_id, relation_type, role_at_date, valid_from, sphere,
        documented_share_money, currency, match_method, validation_state, evidence_ids, is_synthetic)
     values
       ($1,$2,$3,'collective_bench','Deputado Estadual (ficticio)','2026-02-10','state',null,null,'official_id','published',array[$8]::uuid[],true),
       ($1,$4,$3,'collective_bench','Deputado Estadual (ficticio)','2026-02-10','state',null,null,'official_id','published',array[$8]::uuid[],true),
       ($1,$5,$3,'collective_bench','Deputado Federal (ficticio)','2026-02-10','federal',null,null,'official_id','published',array[$8]::uuid[],true),
       ($1,$5,$6,'mentioned_by_source','Deputado Federal (ficticio)','2026-09-05','federal',null,null,'curated_alias','published',array[$7]::uuid[],true)`,
    [
      context.tenantId, en('parlamentar-a'), en('emenda-coletiva-01'), en('parlamentar-b'),
      en('parlamentar-c'), en('ubs-modelo'), ev('doc-noticia-ubs-concluida'), ev('doc-emenda-coletiva'),
    ],
  );

  // Eventos financeiros
  const sourceIds = new Map<string, string>(
    (await db.query<{ code: string; id: string }>(`select code, id from ma.sources`)).rows.map((r) => [r.code, r.id]),
  );
  // Duas passagens: a anulacao referencia o evento que cancela, e esse evento
  // precisa existir antes (11.4 / T14).
  const financialIds = new Map<string, string>();
  const ordered = [
    ...fixture.eventos_financeiros.filter((e) => e.cancela === undefined),
    ...fixture.eventos_financeiros.filter((e) => e.cancela !== undefined),
  ];
  for (const event of ordered) {
    const sourceId = sourceIds.get(event.fonte);
    if (sourceId === undefined) throw new Error(`fonte ${event.fonte} nao cadastrada`);
    const cancels = event.cancela === undefined ? null : financialIds.get(event.cancela) ?? null;
    if (event.cancela !== undefined && cancels === null) {
      throw new Error(`evento cancelado ${event.cancela} nao encontrado para ${event.ref}`);
    }
    const inserted = await one<{ id: string }>(db,
      `insert into ma.financial_events
         (tenant_id, source_id, external_id, payee_entity_id, instrument_id, subject_id,
          financial_document, cancels_event_id, stage, fact_date, budget_year, amendment_year,
          amount_money, currency, measure, link_confirmed, evidence_ids, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::ma.financial_stage,$10,$11,$12,$13,'BRL',
               $14::ma.flow_measure,$15,array[$16]::uuid[],true)
       returning id`,
      [
        context.tenantId, sourceId, event.external_id,
        event.destinatario == null ? null : en(`orgao:${event.destinatario}`),
        event.instrumento == null ? null : en(event.instrumento),
        event.assunto == null ? null : en(event.assunto),
        event.documento_financeiro, cancels, event.etapa, event.data,
        Number(event.data.slice(0, 4)), event.instrumento == null ? null : 2026,
        event.valor.replace(/\./g, '').replace(',', '.'),
        event.medida, event.vinculo_confirmado, ev(event.evidencia),
      ],
    );
    financialIds.set(event.ref, inserted.id);
  }

  // Item de revisao para o conflito de prazo (21.2)
  await db.query(
    `insert into ma.review_queue (tenant_id, kind, target_id, reason, impact, proposed_value, evidence_ids, priority)
     values ($1,'conflict',$2,$3,'affects_emitted_answer',$4::jsonb,array[$5,$6]::uuid[],80)`,
    [
      context.tenantId, currentValidity.id,
      'Prazo de vigencia do contrato 045/2025 divergente entre diario oficial e portal de transparencia',
      JSON.stringify({ predicate: 'contract_validity_end', candidato: '2026-06-29', alternativa: '2025-12-31' }),
      ev('doc-diario-aditivo-quadra'), ev('doc-transparencia-prazo-divergente'),
    ],
  );
});

// ---------------------------------------------------------------------------
// 5. Organizacao vizinha: um assunto proprio, para os testes de isolamento
// ---------------------------------------------------------------------------
await withContext(otherContext, async (db) => {
  const source = await one<{ id: string }>(db,
    `insert into ma.sources
       (tenant_id, code, official_name, domain, organ, sphere, record_types, access_method,
        requires_credentials, access_class, operational_owner, integration_status, enabled)
     values ($1,'F01','Prefeitura vizinha (ficticia)','vizinha.example','Prefeitura vizinha','municipal',
             array['news'],'html',false,'public','operacao-nao-designada','page_located',false)
     on conflict (tenant_id, code) do update set official_name = excluded.official_name
     returning id`,
    [otherContext.tenantId],
  );
  await db.query(
    `insert into ma.source_datasets (tenant_id, source_id, name, record_type)
     values ($1,$2,'noticias','news') on conflict (source_id, name) do nothing`,
    [otherContext.tenantId, source.id],
  );
  const doc = await one<{ id: string }>(db,
    `insert into ma.document_versions
       (tenant_id, source_id, external_id, title_original, title_normalized, content_hash,
        extraction_method, parser_version, text_content, publication_date, is_synthetic)
     values ($1,$2,'SINT-VIZ-0001','Quadra Poliesportiva do Bairro Exemplo (municipio vizinho, ficticio)',
             'quadra poliesportiva do bairro exemplo municipio vizinho ficticio','hash-vizinho-0001',
             'html','fixture-loader/0.1.0',
             'DOCUMENTO FICTICIO DE OUTRO MUNICIPIO. Serve apenas para provar que a consulta de um gabinete nao alcanca o acervo do outro.',
             '2026-09-01', true)
     returning id`,
    [otherContext.tenantId, source.id],
  );
  const entity = await one<{ id: string }>(db,
    `insert into ma.entities
       (tenant_id, municipality_id, kind, official_name, name_normalized, aliases, area, is_synthetic)
     values ($1,$2,'subject','Quadra Poliesportiva do Bairro Exemplo (vizinha)',
             'quadra poliesportiva do bairro exemplo vizinha', array['quadra do exemplo'], 'Esporte', true)
     returning id`,
    [otherContext.tenantId, otherContext.municipalityId],
  );
  const evidence = await one<{ id: string }>(db,
    `insert into ma.evidence (tenant_id, document_version_id, locator, snippet)
     values ($1,$2,'trecho 1','DOCUMENTO FICTICIO DE OUTRO MUNICIPIO.') returning id`,
    [otherContext.tenantId, doc.id],
  );
  const claim = await one<{ id: string }>(db,
    `insert into ma.claims
       (tenant_id, subject_id, predicate, value_text, value_type, fact_date, state,
        validation_state, freshness_class, reviewed_by, review_method, is_synthetic)
     values ($1,$2,'status','obra do municipio vizinho','text','2026-09-01','documented',
             'published','mutable_operational','seed','carga sintetica',true)
     returning id`,
    [otherContext.tenantId, entity.id],
  );
  await db.query(`insert into ma.claim_evidence (claim_id, evidence_id) values ($1,$2)`, [claim.id, evidence.id]);
});

// ---------------------------------------------------------------------------
const counts = await withContext(context, async (db) => {
  const r = await db.query<{ tabela: string; n: string }>(
    `select 'documentos' as tabela, count(*)::text as n from ma.document_versions
     union all select 'evidencias', count(*)::text from ma.evidence
     union all select 'entidades', count(*)::text from ma.entities
     union all select 'afirmacoes', count(*)::text from ma.claims
     union all select 'eventos_financeiros', count(*)::text from ma.financial_events
     union all select 'conflitos', count(*)::text from ma.conflicts
     union all select 'lacunas', count(*)::text from ma.gaps
     union all select 'fila_de_revisao', count(*)::text from ma.review_queue
     union all select 'fontes_cadastradas', count(*)::text from ma.sources
     union all select 'fontes_habilitadas', count(*)::text from ma.sources where enabled`,
  );
  return r.rows;
});

console.log('\n--- ingestao ---');
for (const line of ingestSummary) console.log(`  ${line}`);
console.log('\n--- carga (organizacao de demonstracao) ---');
for (const row of counts) console.log(`  ${row.tabela.padEnd(20)} ${row.n}`);
console.log(`\nlogin do gestor:  ${USER_LOGIN}   organizacao: ${TENANT_SLUG}`);
console.log('Todo o conteudo carregado e sintetico (is_synthetic = true) e nenhuma fonte foi habilitada.\n');

await closePool();
void getPool;
