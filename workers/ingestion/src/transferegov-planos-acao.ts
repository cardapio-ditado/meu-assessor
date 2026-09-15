/**
 * Coleta de planos de acao de transferencias ESPECIAIS no Transferegov (F10)
 * para o municipio do piloto.
 *
 * O que ele faz: descobre o `id_beneficiario` pelo CNPJ do municipio, busca os
 * planos de acao desse beneficiario, guarda documento e evidencia, e deriva as
 * afirmacoes que a resposta cita.
 *
 * O que ele NAO faz, de proposito:
 *
 *  - nao muda `integration_status` nem habilita a fonte. Isso e decisao de
 *    operacao autorizada depois do checklist F.1 (8.1);
 *  - nao trata o plano como dinheiro recebido. Plano de acao aceito e recurso
 *    DESTINADO; empenho, transferencia e pagamento sao outros estagios e moram
 *    em outros endpoints da mesma API (11.1). Nenhuma afirmacao daqui usa
 *    `financial_stage`;
 *  - nao cria relacao tipada entre o parlamentar e a obra. A fonte diz que o
 *    plano vem de uma emenda com aquele identificador; nao diz que alguem
 *    "trouxe", "indicou" ou "executou" (A.5). O parlamentar entra como
 *    qualificador da afirmacao sobre a emenda, com o codigo dele junto;
 *  - nao guarda dado bancario nem email de contato. Ver o comentario da
 *    interface `PlanoAcao`.
 *
 * Uso:
 *   DATABASE_URL=... node --experimental-strip-types \
 *     workers/ingestion/src/transferegov-planos-acao.ts
 */
import { closePool, withContext } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import type { QueryRunner } from '../../../packages/db/src/pool.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { fetchGuarded } from '../../../packages/connectors/src/http.ts';
import {
  objetoDoPlano,
  parsePaginaBeneficiarios,
  parsePaginaPlanosAcao,
  textoDoPlano,
  tituloDoPlano,
  urlBeneficiarios,
  urlPlanosAcao,
  type PlanoAcao,
} from '../../../packages/connectors/src/transferegov.ts';
import { ingestBatch, type RawRecord } from './pipeline.ts';

const PARSER_VERSION = 'transferegov-planos-acao/1.1.0';
const CODIGO_FONTE = 'F10';
const CONJUNTO = 'planos-acao-especiais';

const login = process.env['INGESTION_LOGIN'] ?? 'admin.implantacao';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'varzea-grande';

async function pegarJson(url: string): Promise<unknown> {
  const resposta = await fetchGuarded(url, { maxRetries: 2, maxBytes: 8 * 1024 * 1024 });
  return JSON.parse(resposta.body.toString('utf8'));
}

/**
 * Traduz o CNPJ do municipio no identificador que a API usa.
 *
 * Vale um passo proprio porque e aqui que se erra de municipio: o endpoint de
 * planos aceita `id_beneficiario` e mais nada que identifique o ente. Um id
 * errado traria planos de outra cidade com cara de dado correto.
 */
async function idDoBeneficiario(cnpj: string): Promise<number> {
  const pagina = parsePaginaBeneficiarios(await pegarJson(urlBeneficiarios(cnpj)));
  if (pagina.beneficiarios.length === 0) {
    throw new Error(
      `o Transferegov nao tem beneficiario com o CNPJ ${cnpj}. ` +
        'Isso pode significar que o municipio nunca recebeu transferencia especial, ' +
        'ou que o CNPJ cadastrado esta errado: as duas coisas precisam de conferencia humana.',
    );
  }
  if (pagina.beneficiarios.length > 1) {
    throw new Error(
      `o Transferegov devolveu ${pagina.beneficiarios.length} beneficiarios para o CNPJ ${cnpj}. ` +
        'Escolher um deles por conta propria seria adivinhar de quem e o dinheiro.',
    );
  }
  const b = pagina.beneficiarios[0];
  if (b === undefined) throw new Error('beneficiario ausente apos a verificacao de tamanho');
  console.log(`Beneficiario ${b.idBeneficiario}: ${b.nome} (${b.uf ?? 'UF nao informada'}).`);
  return b.idBeneficiario;
}

/** Busca todas as paginas. O total vem da resposta, nao de palpite. */
async function buscarPlanos(idBeneficiario: number): Promise<{
  readonly planos: PlanoAcao[];
  readonly totalDeclarado: number;
  readonly urls: string[];
}> {
  const planos: PlanoAcao[] = [];
  const urls: string[] = [];
  let pagina = 1;
  let totalDeclarado = 0;

  for (;;) {
    const url = urlPlanosAcao({ idBeneficiario, pagina });
    urls.push(url);
    const dados = parsePaginaPlanosAcao(await pegarJson(url));
    planos.push(...dados.planos);
    totalDeclarado = dados.totalItens;
    if (pagina >= dados.totalPaginas || dados.planos.length === 0) break;
    pagina += 1;
    // Intervalo entre paginas: e portal de orgao publico, nao alvo de carga.
    await new Promise((r) => setTimeout(r, 1_000));
  }

  return { planos, totalDeclarado, urls };
}

function paraRegistro(p: PlanoAcao, url: string): RawRecord {
  return {
    externalId: String(p.idPlanoAcao),
    documentType: 'transfer_instrument',
    title: tituloDoPlano(p),
    issuingOrgan: 'Ministerio da Gestao e da Inovacao em Servicos Publicos',
    numberOriginal: p.codigoPlanoAcao,
    fiscalYear: p.anoPlanoAcao,
    urlOriginal: url,
    urlFinal: url,
    // A fonte NAO publica data de publicacao do plano. Repetir o aceite aqui
    // faria o registro parecer publicado no dia em que foi aceito, que e
    // exatamente a confusao de papeis que o 12.2 proibe.
    publicationDate: null,
    signatureDate: null,
    referenceDate: p.dataAceite,
    mimeType: 'application/json',
    textContent: textoDoPlano(p),
    extractionMethod: 'structured',
    extractionQuality: p.ressalvaValor === null ? 'high' : 'requires_review',
    queryParameters: { id_beneficiario: String(p.idBeneficiario ?? ''), fonte: 'planos-acao-especiais' },
    isSynthetic: false,
  };
}

interface AfirmacaoDesejada {
  readonly predicate: string;
  readonly valueType: 'text' | 'money' | 'date' | 'integer' | 'null';
  readonly text?: string | null;
  readonly money?: bigint | null;
  readonly date?: string | null;
  readonly qualifiers?: Record<string, unknown>;
  readonly nullReason?: string | null;
}

/**
 * As afirmacoes derivadas de um plano de acao.
 *
 * Cada uma responde a uma pergunta que alguem faz em voz alta: de quanto e,
 * de que emenda veio, em que situacao esta, para que area. O que a fonte nao
 * diz nao vira afirmacao — nao ha "valor recebido" aqui.
 */
function afirmacoesDoPlano(p: PlanoAcao): AfirmacaoDesejada[] {
  const lista: AfirmacaoDesejada[] = [
    { predicate: 'transfer_plan_code', valueType: 'text', text: p.codigoPlanoAcao },
    { predicate: 'transfer_plan_status', valueType: 'text', text: p.situacao },
    { predicate: 'transfer_plan_modality', valueType: 'text', text: p.modalidade },
    { predicate: 'transfer_plan_expense_category', valueType: 'text', text: p.categoriaDespesa },
    { predicate: 'transfer_plan_policy_area', valueType: 'text', text: p.areasPoliticasPublicas },
    { predicate: 'transfer_plan_budget_line', valueType: 'text', text: p.programacaoOrcamentaria },
  ];

  if (p.codigoEmendaFormatado !== null || p.numeroEmenda !== null) {
    lista.push({
      predicate: 'transfer_plan_amendment',
      valueType: 'text',
      text: p.codigoEmendaFormatado ?? p.numeroEmenda,
      // O identificador acompanha o nome: e ele que permite ligar esta emenda a
      // outro registro sem depender de semelhanca textual (10.3). O nome do
      // parlamentar e qualificador, nao vinculo de autoria (A.5).
      qualifiers: {
        numero_emenda: p.numeroEmenda,
        codigo_parlamentar: p.codigoParlamentar,
        ano_emenda: p.anoEmenda,
        nome_parlamentar: p.nomeParlamentar,
        vinculo: 'a fonte declara a emenda de origem do plano; nao declara autoria de obra ou execucao',
      },
    });
  }

  const objeto = objetoDoPlano(p);
  if (objeto !== null) {
    lista.push({ predicate: 'transfer_plan_object', valueType: 'text', text: objeto });
  }
  if (p.motivoImpedimento !== null) {
    lista.push({ predicate: 'transfer_plan_impediment', valueType: 'text', text: p.motivoImpedimento });
  }
  if (p.dataAceite !== null) {
    lista.push({ predicate: 'transfer_plan_acceptance_date', valueType: 'date', date: p.dataAceite });
  }

  // Dinheiro: cada parcela e o total. `null` com motivo quando a fonte nao deu
  // ou o valor nao coube em centavos; zero declarado pela fonte fica zero
  // (10.4). O qualificador diz o ESTAGIO, para que ninguem leia como pago.
  const destinado = { estagio: 'destinado pelo plano de acao; nao empenhado, transferido nem pago' };
  const dinheiro: [string, bigint | null, string][] = [
    ['transfer_plan_investment_value', p.investimentoCentavos, 'valor de investimento'],
    ['transfer_plan_current_expense_value', p.custeioCentavos, 'valor de custeio'],
    ['transfer_plan_total_value', p.totalCentavos, 'valor total'],
  ];
  for (const [predicate, centavos, rotulo] of dinheiro) {
    if (centavos === null) {
      lista.push({
        predicate,
        valueType: 'null',
        nullReason: p.ressalvaValor ?? `${rotulo} nao informado pela fonte`,
      });
    } else {
      lista.push({
        predicate,
        valueType: 'money',
        money: centavos,
        qualifiers:
          predicate === 'transfer_plan_total_value'
            ? { ...destinado, origem: 'soma das parcelas de custeio e investimento declaradas pela fonte' }
            : destinado,
      });
    }
  }

  return lista.filter((a) => a.valueType !== 'text' || a.text !== null);
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Liga o plano a sua emenda de origem pelo identificador oficial.
 *
 * Quando a F03 municipal ja trouxe a mesma emenda, reaproveitamos a entidade.
 * Caso contrario criamos uma entidade minima, documentada pela F10. O valor
 * continua sendo o valor DESTINADO no plano; nao criamos evento financeiro,
 * porque isso duplicaria a soma de orcado, empenhado, transferido ou pago.
 */
async function vincularEmendaOrigem(
  db: QueryRunner,
  context: AuthorizedContext,
  p: PlanoAcao,
  planoEntityId: string,
  evidenceId: string,
): Promise<void> {
  const codigo = p.numeroEmenda ?? p.codigoEmendaFormatado;
  if (codigo === null) return;

  const codigoNormalizado = codigo.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (codigoNormalizado.length === 0) return;

  const existente = await db.query<{ id: string }>(
    `select e.id
       from ma.entities e
      where e.tenant_id = $1
        and e.kind = 'amendment'
        and exists (
          select 1
            from jsonb_each_text(e.external_ids) x
           where regexp_replace(upper(x.value), '[^0-9A-Z]', '', 'g') = $2
        )
      order by e.created_at
      limit 1`,
    [context.tenantId, codigoNormalizado],
  );

  let emendaId = existente.rows[0]?.id;
  const aliases = [codigo, p.numeroEmenda, p.codigoEmendaFormatado, p.nomeParlamentar].filter(
    (v): v is string => v !== null && v.trim().length > 0,
  );

  if (emendaId === undefined) {
    const nome = `Emenda ${codigo}${p.nomeParlamentar === null ? '' : ` — ${p.nomeParlamentar}`}`;
    const nova = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, aliases,
          external_ids, area, is_synthetic)
       values ($1,$2,'amendment',$3,$4,$5::text[],$6::jsonb,$7,false)
       returning id`,
      [
        context.tenantId,
        context.municipalityId,
        nome,
        normalizar(nome),
        aliases,
        JSON.stringify({ transferegov_emenda: codigo, codigo_emenda: codigo }),
        p.areasPoliticasPublicas,
      ],
    );
    emendaId = nova.rows[0]?.id;
    if (emendaId === undefined) throw new Error('falha ao criar entidade da emenda de origem');
  } else {
    await db.query(
      `update ma.entities
          set external_ids = external_ids || jsonb_build_object('transferegov_emenda', $3::text),
              aliases = array(
                select distinct valor
                  from unnest(array_cat(coalesce(aliases, '{}'::text[]), $4::text[])) valor
                 where btrim(valor) <> ''
              ),
              area = coalesce(area, $5)
        where tenant_id = $1 and id = $2`,
      [context.tenantId, emendaId, codigo, aliases, p.areasPoliticasPublicas],
    );
  }

  const afirmacoes: AfirmacaoDesejada[] = [
    {
      predicate: 'transferegov_amendment_code',
      valueType: 'text',
      text: codigo,
      qualifiers: { fonte: 'plano de acao de transferencia especial' },
    },
    {
      predicate: 'transferegov_origin_plan',
      valueType: 'text',
      text: p.codigoPlanoAcao,
      qualifiers: { vinculo: 'emenda de origem declarada pela fonte' },
    },
  ];
  if (p.nomeParlamentar !== null) {
    afirmacoes.push({
      predicate: 'transferegov_plan_parliamentarian',
      valueType: 'text',
      text: p.nomeParlamentar,
      qualifiers: {
        codigo_parlamentar: p.codigoParlamentar,
        ressalva: 'nome associado a emenda no plano; nao prova autoria de obra ou execucao',
      },
    });
  }
  if (p.totalCentavos !== null) {
    afirmacoes.push({
      predicate: 'transferegov_plan_total_value',
      valueType: 'money',
      money: p.totalCentavos,
      qualifiers: { estagio: 'destinado no plano; nao empenhado, transferido nem pago' },
    });
  }

  for (const a of afirmacoes) {
    await db.query(
      `update ma.claims set retired_at = now()
        where tenant_id = $1 and subject_id = $2 and predicate = $3 and retired_at is null`,
      [context.tenantId, emendaId, a.predicate],
    );
    const claim = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_money, currency, value_type,
          qualifiers, fact_date, state, validation_state, freshness_class,
          reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,
               'documented'::ma.evidence_state,'auto_validated'::ma.validation_state,
               'stable_history'::ma.freshness_class,$10,$11,false)
       returning id`,
      [
        context.tenantId,
        emendaId,
        a.predicate,
        a.text ?? null,
        a.money == null ? null : (Number(a.money) / 100).toFixed(2),
        a.money == null ? null : 'BRL',
        a.valueType,
        JSON.stringify(a.qualifiers ?? {}),
        p.dataAceite,
        PARSER_VERSION,
        'vinculo exato por identificador oficial declarado no plano de acao',
      ],
    );
    const claimId = claim.rows[0]?.id;
    if (claimId === undefined) throw new Error('falha ao criar afirmacao da emenda de origem');
    await db.query(
      `insert into ma.claim_evidence (claim_id, evidence_id, supports)
       values ($1,$2,'value') on conflict do nothing`,
      [claimId, evidenceId],
    );
  }

  await db.query(
    `insert into ma.chain_links
       (tenant_id, from_entity_id, to_entity_id, from_step, to_step,
        shared_identifier, evidence_ids, fact_date, validation_state)
     select $1,$2,$3,'amendment','transfer_plan',$4,array[$5]::uuid[],$6,
            'auto_validated'::ma.validation_state
      where not exists (
        select 1 from ma.chain_links
         where tenant_id = $1 and from_entity_id = $2 and to_entity_id = $3
           and from_step = 'amendment' and to_step = 'transfer_plan'
           and shared_identifier = $4
      )`,
    [context.tenantId, emendaId, planoEntityId, codigo, evidenceId, p.dataAceite],
  );
}

/**
 * Cria (ou reaproveita) a entidade do plano e grava as afirmacoes ligadas a
 * evidencia do documento.
 *
 * Reaplicar a coleta nao duplica: a entidade e encontrada pelo identificador do
 * Transferegov em `external_ids`, e as afirmacoes anteriores do mesmo predicado
 * sao aposentadas em vez de apagadas (12.5).
 */
async function promover(
  db: QueryRunner,
  context: AuthorizedContext,
  p: PlanoAcao,
): Promise<'criada' | 'atualizada' | 'sem_evidencia'> {
  const externalId = String(p.idPlanoAcao);

  const evidencia = await db.query<{ id: string }>(
    `select ev.id
       from ma.evidence ev
       join ma.document_versions d on d.id = ev.document_version_id
       join ma.sources s on s.id = d.source_id and s.tenant_id = d.tenant_id
      where d.tenant_id = $1 and d.external_id = $2 and s.code = $3
      order by d.record_version desc, ev.obtained_at desc
      limit 1`,
    [context.tenantId, externalId, CODIGO_FONTE],
  );
  let evidenciaId = evidencia.rows[0]?.id;

  /**
   * O pipeline grava o documento; a EVIDENCIA e deste conector, porque o 12.1
   * pede trecho ancorado e so quem leu a fonte sabe o que ancora o que.
   */
  if (evidenciaId === undefined) {
    const documento = await db.query<{ id: string; text_content: string | null }>(
      `select d.id, d.text_content
         from ma.document_versions d
         join ma.sources s on s.id = d.source_id and s.tenant_id = d.tenant_id
        where d.tenant_id = $1 and d.external_id = $2 and s.code = $3
        order by d.record_version desc limit 1`,
      [context.tenantId, externalId, CODIGO_FONTE],
    );
    const doc = documento.rows[0];
    // Sem documento nao ha o que ancorar, e afirmacao sem origem e exatamente o
    // que o produto promete nao fazer.
    if (doc === undefined) return 'sem_evidencia';

    const nova = await db.query<{ id: string }>(
      `insert into ma.evidence (tenant_id, document_version_id, locator, snippet, query_parameters)
       values ($1,$2,$3,$4,$5::jsonb) returning id`,
      [
        context.tenantId,
        doc.id,
        `registro id_plano_acao=${p.idPlanoAcao} em GET /especiais/planos-acao-especiais do Transferegov`,
        (doc.text_content ?? textoDoPlano(p)).slice(0, 1500),
        JSON.stringify({ id_beneficiario: p.idBeneficiario, modulo: 'especiais' }),
      ],
    );
    evidenciaId = nova.rows[0]?.id;
    if (evidenciaId === undefined) return 'sem_evidencia';
  }

  const nome = tituloDoPlano(p);
  const existente = await db.query<{ id: string }>(
    `select id from ma.entities
      where tenant_id = $1 and kind = 'transfer_instrument'
        and external_ids ->> 'transferegov_plano_acao' = $2
      limit 1`,
    [context.tenantId, externalId],
  );

  let entidadeId = existente.rows[0]?.id;
  const criada = entidadeId === undefined;
  if (entidadeId === undefined) {
    const nova = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, external_ids, area, is_synthetic)
       values ($1,$2,'transfer_instrument',$3,$4,$5::jsonb,$6,false)
       returning id`,
      [
        context.tenantId,
        context.municipalityId,
        nome,
        normalizar(nome),
        JSON.stringify({
          transferegov_plano_acao: externalId,
          codigo_plano_acao: p.codigoPlanoAcao,
          numero_emenda: p.numeroEmenda,
        }),
        p.areasPoliticasPublicas,
      ],
    );
    entidadeId = nova.rows[0]?.id;
    if (entidadeId === undefined) throw new Error('falha ao criar entidade do plano de acao');
  }

  for (const a of afirmacoesDoPlano(p)) {
    // 12.5: a versao anterior nao e reescrita, e aposentada.
    await db.query(
      `update ma.claims set retired_at = now()
        where tenant_id = $1 and subject_id = $2 and predicate = $3 and retired_at is null`,
      [context.tenantId, entidadeId, a.predicate],
    );
    const claim = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_money, currency, value_date,
          value_type, qualifiers, fact_date,
          state, validation_state, freshness_class, null_reason, reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,
               'documented'::ma.evidence_state,'auto_validated'::ma.validation_state,
               'stable_history'::ma.freshness_class,$11,$12,$13,false)
       returning id`,
      [
        context.tenantId,
        entidadeId,
        a.predicate,
        a.text ?? null,
        a.money == null ? null : (Number(a.money) / 100).toFixed(2),
        a.money == null ? null : 'BRL',
        a.date ?? null,
        a.valueType,
        JSON.stringify(a.qualifiers ?? {}),
        // A data do FATO e o aceite do plano, unica data que a fonte da (12.2).
        p.dataAceite,
        a.nullReason ?? null,
        PARSER_VERSION,
        'registro estruturado oficial, identificado por id_plano_acao',
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

  await vincularEmendaOrigem(db, context, p, entidadeId, evidenciaId);

  return criada ? 'criada' : 'atualizada';
}

// ---------------------------------------------------------------------------

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
    'O municipio da organizacao nao tem CNPJ cadastrado. O beneficiario no Transferegov e\n' +
      'encontrado pelo CNPJ; sem ele a coleta traria planos de outro ente, que e pior do que\n' +
      'nao coletar.',
  );
  await closePool();
  process.exit(1);
}

process.env['INGESTION_ALLOWED_HOSTS'] ??= 'api-publica.transferegov.gestao.gov.br';
process.env['INGESTION_USER_AGENT'] ??=
  'MeuAssessor/0.1 (coleta de transferencias especiais; +https://github.com/cardapio-ditado/meu-assessor)';

console.log(`Consultando o Transferegov pelo CNPJ ${cnpj}.`);
const idBeneficiario = await idDoBeneficiario(cnpj);
const { planos, totalDeclarado, urls } = await buscarPlanos(idBeneficiario);
console.log(`${planos.length} plano(s) de acao recebido(s); a fonte declarou ${totalDeclarado}.`);

const resultado = await withContext(context, async (db) => {
  const outcome = await ingestBatch(db, context, {
    sourceCode: CODIGO_FONTE,
    datasetName: CONJUNTO,
    // A consulta nao tem recorte de data: pede-se TUDO do beneficiario. Inventar
    // uma janela aqui faria a matriz de cobertura afirmar um periodo que nao foi
    // pedido (9.3).
    requestedFrom: null,
    requestedTo: null,
    records: planos.map((p, i) => paraRegistro(p, urls[Math.min(i, urls.length - 1)] ?? urls[0] ?? '')),
    parserVersion: PARSER_VERSION,
    expectedCount: totalDeclarado,
  });

  let criadas = 0;
  let atualizadas = 0;
  let semEvidencia = 0;
  for (const p of planos) {
    const r = await promover(db, context, p);
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
  `Planos de acao: ${resultado.criadas} entidade(s) criada(s), ${resultado.atualizadas} atualizada(s)` +
    (resultado.semEvidencia > 0 ? `, ${resultado.semEvidencia} sem evidencia (nao viraram afirmacao)` : '') +
    '.',
);
console.log(
  '\nCobertura: somente transferencias ESPECIAIS. Convenios, contratos de repasse e fundo a\n' +
    'fundo estao em outros modulos da mesma API e nao foram coletados.',
);
console.log(
  'Nenhum integration_status foi alterado e nenhuma fonte foi habilitada:\n' +
    'coletar uma amostra e evidencia para o checklist F.1, nao a decisao de habilitar (8.1).',
);

await closePool();

/**
 * Registro recebido que nao virou afirmacao e coleta FALHADA, nao parcial.
 *
 * Um lote que chega ao banco sem virar conteudo consultavel parece sucesso no
 * painel e deixa a tela vazia — o caso mais caro, porque ninguem investiga uma
 * execucao bem-sucedida. Ja aconteceu uma vez nesta base, com o PNCP.
 */
if (resultado.semEvidencia > 0) {
  console.error(
    `\n${resultado.semEvidencia} de ${planos.length} plano(s) nao viraram afirmacao. ` +
      'A coleta gravou documento sem produzir conteudo consultavel; isso e falha, nao resultado parcial.',
  );
  process.exit(1);
}
