/**
 * Coleta de contratos do PNCP (F06) para a organizacao do piloto.
 *
 * Este e o passo do F.1 que faltava para a fonte deixar de ser "endereco que
 * responde" e virar conteudo consultavel: buscar, guardar documento e
 * evidencia, e derivar as afirmacoes que a resposta cita.
 *
 * O que ele NAO faz, de proposito:
 *
 *  - nao muda `integration_status` nem habilita a fonte. Isso e decisao de
 *    operacao autorizada depois do checklist F.1 (8.1), e uma coleta
 *    bem-sucedida e evidencia para essa decisao, nao a decisao;
 *  - nao inventa vinculo. O fornecedor entra como afirmacao com o CNPJ dele
 *    junto, e nao como relacao tipada de autoria: a fonte diz quem contratou,
 *    nao diz quem propos, indicou ou executou (A.5);
 *  - nao arredonda dinheiro. Valor que nao cabe em centavos exatos vira
 *    afirmacao `null` com motivo, e fica para revisao (10.4).
 *
 * Uso:
 *   DATABASE_URL=... node --experimental-strip-types \
 *     workers/ingestion/src/pncp-contratos.ts --de 2026-01-01 --ate 2026-06-30
 */
import { closePool, withContext } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import type { QueryRunner } from '../../../packages/db/src/pool.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { fetchGuarded } from '../../../packages/connectors/src/http.ts';
import {
  parsePaginaContratos,
  textoDoContrato,
  tituloDoContrato,
  urlContratos,
  type ContratoPncp,
} from '../../../packages/connectors/src/pncp.ts';
import { fieldCoverage, ingestBatch, type RawRecord } from './pipeline.ts';

const PARSER_VERSION = 'pncp-contratos/1.0.0';
const CODIGO_FONTE = 'F06';
const CONJUNTO = 'contratos';

function arg(nome: string, padrao: string): string {
  const i = process.argv.indexOf(nome);
  const valor = i === -1 ? undefined : process.argv[i + 1];
  return valor ?? padrao;
}

const hoje = new Date().toISOString().slice(0, 10);
const de = arg('--de', `${hoje.slice(0, 4)}-01-01`);
const ate = arg('--ate', hoje);
const login = process.env['INGESTION_LOGIN'] ?? 'admin.implantacao';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'varzea-grande';

/** Busca todas as paginas da janela. O total vem da resposta, nao de palpite. */
async function buscarContratos(cnpj: string): Promise<{
  readonly contratos: ContratoPncp[];
  readonly totalDeclarado: number;
  readonly urls: string[];
}> {
  const contratos: ContratoPncp[] = [];
  const urls: string[] = [];
  let pagina = 1;
  let totalDeclarado = 0;

  for (;;) {
    const url = urlContratos({ cnpjOrgao: cnpj, janela: { de, ate }, pagina });
    urls.push(url);
    const resposta = await fetchGuarded(url, { maxRetries: 2, maxBytes: 8 * 1024 * 1024 });
    const dados = parsePaginaContratos(JSON.parse(resposta.body.toString('utf8')));
    contratos.push(...dados.contratos);
    totalDeclarado = dados.totalRegistros;
    if (dados.paginasRestantes <= 0) break;
    pagina += 1;
    // Intervalo entre paginas: e portal de orgao publico, nao alvo de carga.
    await new Promise((r) => setTimeout(r, 1_000));
  }

  return { contratos, totalDeclarado, urls };
}

function paraRegistro(c: ContratoPncp, url: string): RawRecord {
  return {
    externalId: c.numeroControlePNCP,
    documentType: 'contract',
    title: tituloDoContrato(c),
    issuingOrgan: c.unidadeNome ?? c.orgaoRazaoSocial,
    numberOriginal: c.numeroContrato,
    fiscalYear: c.anoContrato,
    urlOriginal: url,
    urlFinal: url,
    // Os tres papeis de data ficam separados (12.2). Publicacao no PNCP nao e
    // assinatura: neste orgao ha meses entre uma e outra.
    publicationDate: c.dataPublicacao,
    signatureDate: c.dataAssinatura,
    referenceDate: c.vigenciaInicio,
    mimeType: 'application/json',
    textContent: textoDoContrato(c),
    extractionMethod: 'structured',
    // A fonte e registro estruturado oficial com identificador estavel; o unico
    // caso de duvida e valor que nao coube em centavos.
    extractionQuality: c.ressalvaValor === null ? 'high' : 'requires_review',
    queryParameters: { dataInicial: de, dataFinal: ate, cnpjOrgao: c.orgaoCnpj },
    isSynthetic: false,
  };
}

interface AfirmacaoDesejada {
  readonly predicate: string;
  readonly valueType: 'text' | 'money' | 'date' | 'integer' | 'null';
  readonly text?: string | null;
  readonly money?: bigint | null;
  readonly date?: string | null;
  readonly integer?: number | null;
  readonly qualifiers?: Record<string, unknown>;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly nullReason?: string | null;
}

/**
 * As afirmacoes derivadas de um contrato.
 *
 * Cada uma responde a uma pergunta que alguem faz em voz alta: com quem foi
 * contratado, de quanto, ate quando, de qual unidade. O que a fonte nao diz
 * nao vira afirmacao — nao ha "valor pago" aqui, porque contrato nao e
 * pagamento (11.1).
 */
function afirmacoesDoContrato(c: ContratoPncp): AfirmacaoDesejada[] {
  const lista: AfirmacaoDesejada[] = [
    { predicate: 'contract_object', valueType: 'text', text: c.objeto },
    {
      predicate: 'contract_supplier',
      valueType: 'text',
      text: c.fornecedorNome,
      // O identificador acompanha o nome: e ele que permite ligar o fornecedor
      // a outro registro sem depender de semelhanca textual (10.3).
      qualifiers: { ni: c.fornecedorNi, tipo_pessoa: c.tipoPessoa },
    },
    { predicate: 'contract_organ_unit', valueType: 'text', text: c.unidadeNome ?? c.orgaoRazaoSocial },
  ];

  if (c.valorGlobalCentavos === null) {
    lista.push({
      predicate: 'contract_total_value',
      valueType: 'null',
      // 10.4: ausencia com motivo. Zero seria uma afirmacao falsa.
      nullReason: c.ressalvaValor ?? 'valor nao informado pela fonte',
    });
  } else {
    lista.push({
      predicate: 'contract_total_value',
      valueType: 'money',
      money: c.valorGlobalCentavos,
      qualifiers: { parcelas: c.numeroParcelas },
    });
  }

  if (c.vigenciaInicio !== null || c.vigenciaFim !== null) {
    lista.push({
      predicate: 'contract_validity',
      valueType: 'date',
      date: c.vigenciaFim,
      validFrom: c.vigenciaInicio,
      validTo: c.vigenciaFim,
    });
  }
  if (c.processo !== null) {
    lista.push({ predicate: 'contract_process', valueType: 'text', text: c.processo });
  }
  return lista.filter((a) => a.valueType === 'null' || a.text !== null || a.money != null || a.date !== null);
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cria (ou reaproveita) a entidade do contrato e grava as afirmacoes ligadas a
 * evidencia do documento.
 *
 * Reaplicar a coleta nao duplica: a entidade e encontrada pelo identificador do
 * PNCP em `external_ids`, e as afirmacoes anteriores do mesmo predicado sao
 * aposentadas em vez de apagadas — o 12.5 pede que a versao anterior continue
 * existindo.
 */
async function promover(
  db: QueryRunner,
  context: AuthorizedContext,
  c: ContratoPncp,
): Promise<'criada' | 'atualizada' | 'sem_evidencia'> {
  const evidencia = await db.query<{ id: string }>(
    `select ev.id
       from ma.evidence ev
       join ma.document_versions d on d.id = ev.document_version_id
      where d.tenant_id = $1 and d.external_id = $2
      order by d.record_version desc, ev.obtained_at desc
      limit 1`,
    [context.tenantId, c.numeroControlePNCP],
  );
  let evidenciaId = evidencia.rows[0]?.id;

  /**
   * O pipeline grava o documento; a EVIDENCIA e deste conector.
   *
   * E o lugar certo: o 12.1 pede trecho ancorado, e so quem leu a fonte sabe o
   * que ancora o que. O localizador nomeia o registro e a operacao que o
   * devolveu, e os parametros de consulta vao junto — sem credencial, que aqui
   * nem existe.
   */
  if (evidenciaId === undefined) {
    const documento = await db.query<{ id: string; text_content: string | null }>(
      `select id, text_content from ma.document_versions
        where tenant_id = $1 and external_id = $2
        order by record_version desc limit 1`,
      [context.tenantId, c.numeroControlePNCP],
    );
    const doc = documento.rows[0];
    // Sem documento nao ha o que ancorar, e afirmacao sem origem e exatamente o
    // que o produto promete nao fazer.
    if (doc === undefined) return 'sem_evidencia';

    const trecho = (doc.text_content ?? textoDoContrato(c)).slice(0, 1500);
    const nova = await db.query<{ id: string }>(
      `insert into ma.evidence (tenant_id, document_version_id, locator, snippet, query_parameters)
       values ($1,$2,$3,$4,$5::jsonb) returning id`,
      [
        context.tenantId,
        doc.id,
        `registro ${c.numeroControlePNCP} em GET /v1/contratos do PNCP`,
        trecho,
        JSON.stringify({ dataInicial: de, dataFinal: ate, cnpjOrgao: c.orgaoCnpj }),
      ],
    );
    evidenciaId = nova.rows[0]?.id;
    if (evidenciaId === undefined) return 'sem_evidencia';
  }

  const nome = tituloDoContrato(c);
  const existente = await db.query<{ id: string }>(
    `select id from ma.entities
      where tenant_id = $1 and kind = 'contract'
        and external_ids ->> 'pncp' = $2
      limit 1`,
    [context.tenantId, c.numeroControlePNCP],
  );

  let entidadeId = existente.rows[0]?.id;
  const criada = entidadeId === undefined;
  if (entidadeId === undefined) {
    const nova = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, external_ids, area, is_synthetic)
       values ($1,$2,'contract',$3,$4,$5::jsonb,$6,false)
       returning id`,
      [
        context.tenantId,
        context.municipalityId,
        nome,
        normalizar(nome),
        JSON.stringify({ pncp: c.numeroControlePNCP, processo: c.processo }),
        c.unidadeNome,
      ],
    );
    entidadeId = nova.rows[0]?.id;
    if (entidadeId === undefined) throw new Error('falha ao criar entidade do contrato');
  }

  for (const a of afirmacoesDoContrato(c)) {
    // 12.5: a versao anterior nao e reescrita, e aposentada.
    await db.query(
      `update ma.claims set retired_at = now()
        where tenant_id = $1 and subject_id = $2 and predicate = $3 and retired_at is null`,
      [context.tenantId, entidadeId, a.predicate],
    );
    const claim = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_money, currency, value_date,
          value_numeric, value_type, qualifiers, valid_from, valid_to, fact_date,
          state, validation_state, freshness_class, null_reason, reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,
               'documented'::ma.evidence_state,'auto_validated'::ma.validation_state,
               'stable_history'::ma.freshness_class,$14,$15,$16,false)
       returning id`,
      [
        context.tenantId,
        entidadeId,
        a.predicate,
        a.text ?? null,
        a.money == null ? null : (Number(a.money) / 100).toFixed(2),
        a.money == null ? null : 'BRL',
        a.date ?? null,
        a.integer ?? null,
        a.valueType,
        JSON.stringify(a.qualifiers ?? {}),
        a.validFrom ?? null,
        a.validTo ?? null,
        // A data do FATO e a assinatura, nao a publicacao no PNCP (12.2).
        c.dataAssinatura,
        a.nullReason ?? null,
        PARSER_VERSION,
        'registro estruturado oficial, identificado por numeroControlePNCP',
      ],
    );
    const claimId = claim.rows[0]?.id;
    if (claimId === undefined) throw new Error('falha ao criar afirmacao');
    await db.query(
      `insert into ma.claim_evidence (claim_id, evidence_id, supports)
       values ($1,$2,'value') on conflict do nothing`,
      [claimId, evidenciaId],
    );
  }

  return criada ? 'criada' : 'atualizada';
}

const context = await contextFor(login, tenantSlug);

const cnpj = await withContext(context, async (db) => {
  const r = await db.query<{ primary_cnpj: string | null }>(
    `select mu.primary_cnpj
       from ma.municipalities mu
       join ma.tenant_municipalities tm on tm.municipality_id = mu.id
      where tm.tenant_id = $1
      limit 1`,
    [context.tenantId],
  );
  return r.rows[0]?.primary_cnpj ?? null;
});

if (cnpj === null) {
  console.error(
    'O municipio da organizacao nao tem CNPJ cadastrado. A consulta ao PNCP e por CNPJ do orgao;\n' +
      'sem ele a coleta traria contratos de outro ente, que e pior do que nao coletar.',
  );
  await closePool();
  process.exit(1);
}

process.env['INGESTION_ALLOWED_HOSTS'] ??= 'pncp.gov.br';
process.env['INGESTION_USER_AGENT'] ??=
  'MeuAssessor/0.1 (coleta de contratos; +https://github.com/cardapio-ditado/meu-assessor)';

console.log(`Coletando contratos do PNCP de ${de} a ${ate}, CNPJ ${cnpj}.`);
const { contratos, totalDeclarado, urls } = await buscarContratos(cnpj);
console.log(`${contratos.length} contrato(s) recebido(s); a fonte declarou ${totalDeclarado}.`);

const resultado = await withContext(context, async (db) => {
  const registros = contratos.map((c, i) =>
    paraRegistro(c, urls[Math.min(i, urls.length - 1)] ?? urls[0] ?? ''),
  );
  const outcome = await ingestBatch(db, context, {
    sourceCode: CODIGO_FONTE,
    datasetName: CONJUNTO,
    requestedFrom: de,
    requestedTo: ate,
    records: registros,
    parserVersion: PARSER_VERSION,
    expectedCount: totalDeclarado,
  });

  /**
   * Matriz de cobertura (9.3): intervalo PEDIDO ao lado do intervalo
   * ENCONTRADO.
   *
   * E o que transforma tela vazia em resposta. Sem isto, uma janela sem
   * contrato nenhum e indistinguivel de coleta que nunca rodou — e o produto
   * fica em silencio justamente onde deveria dizer "o provedor nao publicou
   * nada neste periodo, e a ultima publicacao foi em tal data".
   */
  const publicadas = registros
    .map((r) => r.publicationDate)
    .filter((d): d is string => d !== null)
    .sort();
  await db.query(
    `insert into ma.coverage_matrix
       (tenant_id, dataset_id, requested_from, requested_to, found_from, found_to,
        temporal_coverage, record_count, failure_count, field_coverage, last_verified_at, verified_by)
     select $1, sd.id, $2, $3, $4, $5, $6, $7, 0, $8::jsonb, now(), $9
       from ma.source_datasets sd
       join ma.sources s on s.id = sd.source_id
      where s.code = $10 and sd.name = $11
     on conflict (dataset_id, requested_from, requested_to) do update
       set found_from = excluded.found_from,
           found_to = excluded.found_to,
           temporal_coverage = excluded.temporal_coverage,
           record_count = excluded.record_count,
           field_coverage = excluded.field_coverage,
           last_verified_at = excluded.last_verified_at`,
    [
      context.tenantId,
      de,
      ate,
      publicadas[0] ?? null,
      publicadas[publicadas.length - 1] ?? null,
      // Nao ha como afirmar "completo conforme o provedor" sem verificar o que
      // ele deveria ter; o que se pode afirmar e o que veio.
      contratos.length === 0 ? 'unavailable' : 'partial',
      contratos.length,
      JSON.stringify(fieldCoverage(registros)),
      PARSER_VERSION,
      CODIGO_FONTE,
      CONJUNTO,
    ],
  );

  let criadas = 0;
  let atualizadas = 0;
  let semEvidencia = 0;
  for (const c of contratos) {
    const r = await promover(db, context, c);
    if (r === 'criada') criadas += 1;
    else if (r === 'atualizada') atualizadas += 1;
    else semEvidencia += 1;
  }
  return { outcome, criadas, atualizadas, semEvidencia };
});

console.log(
  `Documentos: ${resultado.outcome.inserted} novo(s), ${resultado.outcome.newVersions} versao(oes) nova(s), ` +
    `${resultado.outcome.unchanged} sem alteracao, ${resultado.outcome.quarantined} em quarentena.`,
);
console.log(
  `Contratos: ${resultado.criadas} entidade(s) criada(s), ${resultado.atualizadas} atualizada(s)` +
    (resultado.semEvidencia > 0 ? `, ${resultado.semEvidencia} sem evidencia (nao viraram afirmacao)` : '') +
    '.',
);
console.log(
  '\nNenhum integration_status foi alterado e nenhuma fonte foi habilitada:\n' +
    'coletar uma amostra e evidencia para o checklist F.1, nao a decisao de habilitar (8.1).',
);

await closePool();

/**
 * Contrato recebido que nao virou afirmacao e coleta FALHADA, nao parcial.
 *
 * A primeira execucao real trouxe 28 documentos e produziu zero afirmacoes — e
 * terminou verde, porque so os documentos contavam. Um lote que chega ao banco
 * sem virar conteudo consultavel parece sucesso no painel e deixa a tela vazia,
 * que e o caso mais caro de todos: ninguem vai investigar uma execucao
 * bem-sucedida.
 */
if (resultado.semEvidencia > 0) {
  console.error(
    `\n${resultado.semEvidencia} de ${contratos.length} contrato(s) nao viraram afirmacao. ` +
      'A coleta gravou documento sem produzir conteudo consultavel; isso e falha, nao resultado parcial.',
  );
  process.exit(1);
}
