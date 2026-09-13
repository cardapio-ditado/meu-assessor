/**
 * Coleta de edicoes do Diario Oficial de Varzea Grande (F04).
 *
 * Primeira fonte de DOCUMENTO do produto: as duas anteriores eram registro
 * estruturado, esta e PDF. O que muda:
 *
 *  - a extracao e por texto NATIVO, nunca OCR. O diagnostico da edicao 539
 *    mostrou 24 paginas com 20 mapas `ToUnicode` e 7127 operadores de texto;
 *    OCR e ultimo recurso (13.2) e esta fonte nao precisa;
 *  - o texto guardado leva marca de pagina, para a evidencia poder dizer ONDE
 *    num documento de dezenas de paginas esta o trecho (12.1);
 *  - pagina que nao rendeu caractere nenhum fica REGISTRADA, nao sumida: um
 *    encarte de imagem no meio do diario e um pedaco que nao foi lido, e quem
 *    le o relatorio precisa saber (9.3).
 *
 * O que ele NAO faz, de proposito:
 *
 *  - nao extrai os ATOS de dentro da edicao. Portaria, extrato de contrato e
 *    aditivo sao texto corrido dentro do PDF, e transformar isso em afirmacao
 *    tipada exige um extrator proprio, testado ato a ato. Fazer por regex
 *    apressada produziria "contrato" com valor e fornecedor plausiveis e
 *    errados — o defeito mais caro que este produto pode ter. Fica para um
 *    passo proprio; por ora a edicao entra como documento consultavel por
 *    busca em texto, e as afirmacoes sao sobre a EDICAO, nao sobre os atos;
 *  - nao muda `integration_status` nem habilita a fonte (8.1).
 *
 * Uso:
 *   DATABASE_URL=... node --experimental-strip-types \
 *     workers/ingestion/src/diario-vg-edicoes.ts [--ultimas 10] [--de aaaa-mm-dd --ate aaaa-mm-dd]
 */
import { closePool, withContext } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import type { QueryRunner } from '../../../packages/db/src/pool.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { fetchGuarded } from '../../../packages/connectors/src/http.ts';
import { extrairTextoPdf, type PaginaPdf } from '../../../packages/connectors/src/pdf.ts';
import {
  idExterno,
  parseListagem,
  textoDaEdicao,
  tituloDaEdicao,
  urlDoPdf,
  urlListagem,
  type EdicaoListada,
} from '../../../packages/connectors/src/diario-vg.ts';
import { ingestBatch, type RawRecord } from './pipeline.ts';

const PARSER_VERSION = 'diario-vg-edicoes/1.0.0';
const CODIGO_FONTE = 'F04';
const CONJUNTO = 'edicoes';

/** Teto de seguranca: uma edicao anomala nao pode travar a coleta inteira. */
const MAX_PAGINAS = 400;

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

const de = arg('--de') ?? null;
const ate = arg('--ate') ?? null;
const ultimas = Number(arg('--ultimas') ?? 10);
const login = process.env['INGESTION_LOGIN'] ?? 'admin.implantacao';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'varzea-grande';

interface EdicaoBaixada {
  readonly edicao: EdicaoListada;
  readonly urlPdf: string;
  readonly paginas: readonly PaginaPdf[];
  readonly totalPaginas: number;
  readonly paginasSemTexto: readonly number[];
}

async function baixar(url: string): Promise<Buffer> {
  const r = await fetchGuarded(url, { maxRetries: 2, maxBytes: 64 * 1024 * 1024 });
  return r.body;
}

/**
 * Escolhe quais edicoes coletar.
 *
 * Duas formas, porque as duas perguntas sao legitimas: "o que saiu entre tais
 * datas" e "o que saiu de mais recente". A janela por data e preferida quando
 * dada; sem ela, as ultimas N — e NAO uma janela inventada em cima de hoje,
 * que na primeira execucao traria zero edicoes e pareceria falha de coleta
 * quando seria apenas o municipio nao ter publicado.
 */
function selecionar(todas: readonly EdicaoListada[]): readonly EdicaoListada[] {
  const ordenadas = [...todas].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  if (de !== null || ate !== null) {
    return ordenadas.filter((e) => (de === null || e.data >= de) && (ate === null || e.data <= ate));
  }
  return ordenadas.slice(0, ultimas);
}

function paraRegistro(b: EdicaoBaixada): RawRecord {
  const ressalva = b.paginasSemTexto.length > 0;
  return {
    externalId: idExterno(b.edicao),
    documentType: 'official_gazette',
    title: tituloDaEdicao(b.edicao),
    issuingOrgan: 'Prefeitura Municipal de Varzea Grande',
    numberOriginal: b.edicao.numero,
    fiscalYear: Number(b.edicao.data.slice(0, 4)),
    urlOriginal: b.edicao.urlEdicao,
    urlFinal: b.urlPdf,
    // Para um diario oficial, a data da edicao E a data de publicacao — este e
    // o raro caso em que os papeis coincidem por definicao, e nao por descuido.
    publicationDate: b.edicao.data,
    signatureDate: null,
    referenceDate: b.edicao.data,
    mimeType: 'application/pdf',
    textContent: textoDaEdicao(b.edicao, b.paginas),
    extractionMethod: 'native_text',
    // Pagina sem texto e motivo de revisao: parte do diario nao foi lida.
    extractionQuality: ressalva ? 'requires_review' : 'high',
    queryParameters: { listagem: urlListagem(), edicao: b.edicao.id },
    isSynthetic: false,
  };
}

interface AfirmacaoDesejada {
  readonly predicate: string;
  readonly valueType: 'text' | 'date' | 'integer';
  readonly text?: string | null;
  readonly date?: string | null;
  readonly integer?: number | null;
  readonly qualifiers?: Record<string, unknown>;
}

/**
 * As afirmacoes derivadas de uma edicao.
 *
 * Sao sobre a EDICAO — numero, data, tipo, extensao, onde esta o arquivo. NAO
 * ha aqui nenhuma afirmacao sobre contrato, portaria ou nomeacao: isso esta no
 * texto do PDF e vira afirmacao quando houver extrator de ato testado, nao
 * antes. Afirmar menos e o que permite afirmar com evidencia.
 */
function afirmacoesDaEdicao(b: EdicaoBaixada): AfirmacaoDesejada[] {
  const lista: AfirmacaoDesejada[] = [
    { predicate: 'gazette_number', valueType: 'text', text: b.edicao.numero },
    { predicate: 'gazette_publication_date', valueType: 'date', date: b.edicao.data },
    {
      predicate: 'gazette_page_count',
      valueType: 'integer',
      integer: b.totalPaginas,
      qualifiers:
        b.paginasSemTexto.length === 0
          ? { paginas_sem_texto: 0 }
          : {
              paginas_sem_texto: b.paginasSemTexto.length,
              quais: b.paginasSemTexto,
              ressalva: 'paginas sem texto extraivel nao foram lidas; podem ser encarte de imagem',
            },
    },
    { predicate: 'gazette_file', valueType: 'text', text: b.urlPdf },
  ];
  if (b.edicao.tipo !== null) {
    lista.push({ predicate: 'gazette_type', valueType: 'text', text: b.edicao.tipo });
  }
  return lista;
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
 * Cria (ou reaproveita) a entidade da edicao e grava as afirmacoes ligadas a
 * evidencia do documento.
 *
 * A chave e o id interno do portal, NAO o numero da edicao: ha duas edicoes 538
 * no mesmo dia, uma normal e uma suplemento (13.3).
 */
async function promover(
  db: QueryRunner,
  context: AuthorizedContext,
  b: EdicaoBaixada,
): Promise<'criada' | 'atualizada' | 'sem_evidencia'> {
  const externalId = idExterno(b.edicao);

  const evidencia = await db.query<{ id: string }>(
    `select ev.id
       from ma.evidence ev
       join ma.document_versions d on d.id = ev.document_version_id
      where d.tenant_id = $1 and d.external_id = $2
      order by d.record_version desc, ev.obtained_at desc
      limit 1`,
    [context.tenantId, externalId],
  );
  let evidenciaId = evidencia.rows[0]?.id;

  if (evidenciaId === undefined) {
    const documento = await db.query<{ id: string }>(
      `select id from ma.document_versions
        where tenant_id = $1 and external_id = $2
        order by record_version desc limit 1`,
      [context.tenantId, externalId],
    );
    const doc = documento.rows[0];
    if (doc === undefined) return 'sem_evidencia';

    /**
     * O trecho da evidencia e o INICIO DA PRIMEIRA PAGINA, e o localizador diz
     * qual pagina e. Num documento de 24 paginas, "esta no diario" nao ancora
     * nada (12.1); dizer a pagina permite conferir.
     */
    const primeira = b.paginas[0];
    const trecho = (primeira?.texto ?? '').slice(0, 1500);
    const nova = await db.query<{ id: string }>(
      `insert into ma.evidence (tenant_id, document_version_id, locator, snippet, query_parameters)
       values ($1,$2,$3,$4,$5::jsonb) returning id`,
      [
        context.tenantId,
        doc.id,
        `pagina ${primeira?.numero ?? 1} de ${b.totalPaginas} da edicao ${b.edicao.numero}` +
          `${b.edicao.tipo === null ? '' : ` (${b.edicao.tipo})`} de ${b.edicao.data}, em ${b.urlPdf}`,
        trecho,
        JSON.stringify({ edicao: b.edicao.id, paginas: b.totalPaginas, origem: b.edicao.urlEdicao }),
      ],
    );
    evidenciaId = nova.rows[0]?.id;
    if (evidenciaId === undefined) return 'sem_evidencia';
  }

  const nome = tituloDaEdicao(b.edicao);
  const existente = await db.query<{ id: string }>(
    `select id from ma.entities
      where tenant_id = $1 and kind = 'official_publication'
        and external_ids ->> 'diario_vg_edicao' = $2
      limit 1`,
    [context.tenantId, b.edicao.id],
  );

  let entidadeId = existente.rows[0]?.id;
  const criada = entidadeId === undefined;
  if (entidadeId === undefined) {
    const nova = await db.query<{ id: string }>(
      `insert into ma.entities
         (tenant_id, municipality_id, kind, official_name, name_normalized, external_ids, area, is_synthetic)
       values ($1,$2,'official_publication',$3,$4,$5::jsonb,$6,false)
       returning id`,
      [
        context.tenantId,
        context.municipalityId,
        nome,
        normalizar(nome),
        JSON.stringify({
          diario_vg_edicao: b.edicao.id,
          numero_edicao: b.edicao.numero,
          tipo: b.edicao.tipo,
        }),
        'Diario Oficial',
      ],
    );
    entidadeId = nova.rows[0]?.id;
    if (entidadeId === undefined) throw new Error('falha ao criar entidade da edicao');
  }

  for (const a of afirmacoesDaEdicao(b)) {
    // 12.5: a versao anterior nao e reescrita, e aposentada.
    await db.query(
      `update ma.claims set retired_at = now()
        where tenant_id = $1 and subject_id = $2 and predicate = $3 and retired_at is null`,
      [context.tenantId, entidadeId, a.predicate],
    );
    const claim = await db.query<{ id: string }>(
      `insert into ma.claims
         (tenant_id, subject_id, predicate, value_text, value_date, value_numeric, value_type,
          qualifiers, fact_date, state, validation_state, freshness_class,
          reviewed_by, review_method, is_synthetic)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,
               'documented'::ma.evidence_state,'auto_validated'::ma.validation_state,
               'stable_history'::ma.freshness_class,$10,$11,false)
       returning id`,
      [
        context.tenantId,
        entidadeId,
        a.predicate,
        a.text ?? null,
        a.date ?? null,
        a.integer ?? null,
        a.valueType,
        JSON.stringify(a.qualifiers ?? {}),
        b.edicao.data,
        PARSER_VERSION,
        'edicao publicada no diario oficial do municipio, identificada pelo id do portal',
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

// ---------------------------------------------------------------------------

const context = await contextFor(login, tenantSlug);

process.env['INGESTION_ALLOWED_HOSTS'] ??= 'diariooficial.varzeagrande.mt.gov.br';
process.env['INGESTION_USER_AGENT'] ??=
  'MeuAssessor/0.1 (coleta do diario oficial; +https://github.com/cardapio-ditado/meu-assessor)';

console.log(`Lendo a listagem em ${urlListagem()}.`);
const listagem = (await baixar(urlListagem())).toString('utf8');
const todas = parseListagem(listagem);
const escolhidas = selecionar(todas);

console.log(
  `${todas.length} edicao(oes) na listagem; ${escolhidas.length} selecionada(s) ` +
    (de !== null || ate !== null ? `pela janela ${de ?? 'inicio'} a ${ate ?? 'fim'}.` : `pelas ultimas ${ultimas}.`),
);

if (escolhidas.length === 0) {
  /**
   * Zero edicoes na janela e um FATO SOBRE A FONTE, nao uma falha de coleta.
   *
   * A distincao importa: "o municipio nao publicou nada nesse periodo" e uma
   * resposta legitima, e tratar isso como erro ensinaria a ignorar o alarme.
   * A edicao mais recente fica no aviso para que a lacuna seja visivel.
   */
  const maisRecente = [...todas].sort((a, b) => (a.data < b.data ? 1 : -1))[0];
  console.log(
    'Nenhuma edicao na janela pedida. Isso e cobertura, nao falha: a edicao mais recente\n' +
      `publicada pelo portal e a ${maisRecente?.numero} de ${maisRecente?.data}.`,
  );
  await closePool();
  process.exit(0);
}

const baixadas: EdicaoBaixada[] = [];
for (const edicao of escolhidas) {
  const pagina = (await baixar(edicao.urlEdicao)).toString('utf8');
  const pdf = urlDoPdf(pagina);
  const bytes = await baixar(pdf);
  const extraido = await extrairTextoPdf(bytes, { maxPaginas: MAX_PAGINAS });
  console.log(
    `  edicao ${edicao.numero}${edicao.tipo === null ? '' : ` (${edicao.tipo})`} de ${edicao.data}: ` +
      `${extraido.totalPaginas} pagina(s), ${extraido.texto.length} caractere(s)` +
      (extraido.paginasSemTexto.length > 0 ? `, ${extraido.paginasSemTexto.length} sem texto` : ''),
  );
  baixadas.push({
    edicao,
    urlPdf: pdf,
    paginas: extraido.paginas,
    totalPaginas: extraido.totalPaginas,
    paginasSemTexto: extraido.paginasSemTexto,
  });
  // Intervalo entre edicoes: e portal de prefeitura, nao alvo de carga, e cada
  // edicao ja custa um PDF de centenas de kilobytes.
  await new Promise((r) => setTimeout(r, 1_500));
}

const resultado = await withContext(context, async (db) => {
  const outcome = await ingestBatch(db, context, {
    sourceCode: CODIGO_FONTE,
    datasetName: CONJUNTO,
    requestedFrom: de,
    requestedTo: ate,
    records: baixadas.map(paraRegistro),
    parserVersion: PARSER_VERSION,
    // O universo demonstravel e a propria listagem quando ha janela de datas;
    // no modo "ultimas N" nao ha total esperado, e a cobertura fica parcial (9.3).
    expectedCount: de !== null || ate !== null ? escolhidas.length : null,
  });

  let criadas = 0;
  let atualizadas = 0;
  let semEvidencia = 0;
  for (const b of baixadas) {
    const r = await promover(db, context, b);
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
  `Edicoes: ${resultado.criadas} entidade(s) criada(s), ${resultado.atualizadas} atualizada(s)` +
    (resultado.semEvidencia > 0 ? `, ${resultado.semEvidencia} sem evidencia` : '') +
    '.',
);

const semTexto = baixadas.filter((b) => b.paginasSemTexto.length > 0);
if (semTexto.length > 0) {
  console.log(
    `\nRessalva: ${semTexto.length} edicao(oes) tem pagina sem texto extraivel. ` +
      'Essas paginas NAO foram lidas e as afirmacoes trazem a ressalva.',
  );
}
console.log(
  '\nEscopo: a edicao entra como documento consultavel por busca. Os ATOS de dentro\n' +
    '(portarias, extratos de contrato, aditivos) NAO viraram afirmacao: isso exige\n' +
    'extrator de ato testado, e regex apressada produziria contrato plausivel e errado.',
);
console.log(
  'Nenhum integration_status foi alterado e nenhuma fonte foi habilitada (8.1).',
);

await closePool();

/**
 * Documento que nao virou afirmacao e coleta FALHADA, nao parcial. Ja aconteceu
 * uma vez nesta base, com o PNCP, e terminou verde.
 */
if (resultado.semEvidencia > 0) {
  console.error(
    `\n${resultado.semEvidencia} de ${baixadas.length} edicao(oes) nao viraram afirmacao. ` +
      'A coleta gravou documento sem produzir conteudo consultavel; isso e falha, nao resultado parcial.',
  );
  process.exit(1);
}
