/**
 * Conector do Transferegov.br — planos de acao de transferencias ESPECIAIS
 * (fonte F10).
 *
 * Os enderecos e os parametros vieram da especificacao OpenAPI publicada pelo
 * proprio portal (`/especiais/openapi.json`, lida em 2026-09-13), e a forma dos
 * registros veio de uma resposta real do municipio do piloto. Nenhum campo aqui
 * foi deduzido de memoria (8.3).
 *
 * Duas coisas descobertas em execucao, nao supostas:
 *
 *  - o filtro recebe o VALOR CRU (`cnpj_beneficiario=03507548000110`). A
 *    primeira tentativa usou a sintaxe de operador do PostgREST
 *    (`=eq.03507548000110`) e voltou 200 com zero registros — filtro aplicado
 *    sobre um literal inexistente, que e o modo silencioso de errar: a resposta
 *    nao e um erro, e uma lista vazia;
 *  - o municipio nao e parametro do plano de acao. O vinculo e por
 *    `id_beneficiario`, obtido a partir do CNPJ em `/beneficiarios-especiais`.
 *    Ligar por identificador, e nao por semelhanca de nome, e o que o 10.3
 *    exige.
 *
 * ESCOPO, dito explicitamente porque o nome do portal e maior que o que este
 * modulo cobre: aqui ha somente transferencias ESPECIAIS (emendas de
 * transferencia especial). Convenios, contratos de repasse e fundo a fundo
 * moram em outros modulos da mesma API e NAO sao coletados por este conector.
 *
 * Este modulo e PURO: monta endereco, valida e normaliza. Nao faz requisicao e
 * nao toca no banco.
 *
 * Contrato dos endpoints, verbatim da especificacao:
 *
 *   GET /especiais/beneficiarios-especiais
 *     cnpj_beneficiario   opcional   somente digitos
 *     pagina              opcional   integer
 *     tamanho_da_pagina   opcional   integer
 *
 *   GET /especiais/planos-acao-especiais
 *     id_beneficiario     opcional
 *     ano_plano_acao      opcional
 *     pagina              opcional   integer
 *     tamanho_da_pagina   opcional   integer
 *     (e mais 30 filtros que este conector nao usa)
 */
import { ConnectorError } from './http.ts';
import { centavosExatos } from './dinheiro.ts';

export const TRANSFEREGOV_BASE = 'https://api-publica.transferegov.gestao.gov.br/especiais';

/** Confirmado em execucao real: a API aceita este tamanho e devolve o total. */
export const TAMANHO_PAGINA = 50;

/** Somente digitos: o campo da fonte guarda CNPJ sem pontuacao. */
export function digitosCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

export function urlBeneficiarios(cnpj: string): string {
  const digitos = digitosCnpj(cnpj);
  if (digitos.length !== 14) {
    throw new ConnectorError(
      `CNPJ ${cnpj} nao tem 14 digitos; consultar com identificador truncado traria o beneficiario errado`,
      'schema_changed',
      false,
    );
  }
  const q = new URLSearchParams({ cnpj_beneficiario: digitos });
  return `${TRANSFEREGOV_BASE}/beneficiarios-especiais?${q.toString()}`;
}

export function urlPlanosAcao(params: {
  readonly idBeneficiario: number;
  readonly pagina: number;
  readonly tamanhoPagina?: number;
}): string {
  const q = new URLSearchParams({
    id_beneficiario: String(params.idBeneficiario),
    pagina: String(params.pagina),
    tamanho_da_pagina: String(params.tamanhoPagina ?? TAMANHO_PAGINA),
  });
  return `${TRANSFEREGOV_BASE}/planos-acao-especiais?${q.toString()}`;
}

interface Bruto {
  readonly [k: string]: unknown;
}

/** Envelope comum a todos os endpoints deste modulo da API. */
export interface Envelope {
  readonly totalItens: number;
  readonly totalPaginas: number;
  readonly paginaAtual: number;
  readonly tamanhoPagina: number;
}

function envelope(raiz: Bruto): Envelope {
  const numero = (chave: string): number => (typeof raiz[chave] === 'number' ? (raiz[chave] as number) : 0);
  return {
    totalItens: numero('total_items'),
    totalPaginas: numero('total_pages'),
    paginaAtual: numero('page_number'),
    tamanhoPagina: numero('page_size'),
  };
}

function listaDeDados(corpo: unknown, ondeVeio: string): { readonly raiz: Bruto; readonly dados: unknown[] } {
  if (corpo === null || typeof corpo !== 'object') {
    throw new ConnectorError(`resposta de ${ondeVeio} nao e um objeto`, 'schema_changed', false);
  }
  const raiz = corpo as Bruto;
  const dados = raiz['data'];
  if (!Array.isArray(dados)) {
    throw new ConnectorError(`resposta de ${ondeVeio} sem a lista \`data\``, 'schema_changed', false);
  }
  return { raiz, dados };
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

function inteiro(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isInteger(valor) ? valor : null;
}

/** Recorta a parte de data de "2020-05-21" ou "2020-05-21T10:00:00". */
function soData(valor: unknown): string | null {
  const t = texto(valor);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m === null ? null : (m[1] ?? null);
}

// ---------------------------------------------------------------------------
// Beneficiario
// ---------------------------------------------------------------------------

export interface Beneficiario {
  readonly idBeneficiario: number;
  readonly nome: string;
  readonly cnpj: string;
  readonly uf: string | null;
  readonly idEnte: number | null;
}

export interface PaginaBeneficiarios extends Envelope {
  readonly beneficiarios: readonly Beneficiario[];
}

export function parsePaginaBeneficiarios(corpo: unknown): PaginaBeneficiarios {
  const { raiz, dados } = listaDeDados(corpo, 'beneficiarios-especiais');
  const beneficiarios = dados.map((item, i): Beneficiario => {
    if (item === null || typeof item !== 'object') {
      throw new ConnectorError(`beneficiario ${i} nao e um objeto`, 'schema_changed', false);
    }
    const b = item as Bruto;
    const id = inteiro(b['id_beneficiario']);
    const nome = texto(b['nome_beneficiario']);
    const cnpj = texto(b['cnpj_beneficiario']);
    if (id === null || nome === null || cnpj === null) {
      throw new ConnectorError(
        `beneficiario ${i} sem id_beneficiario, nome ou cnpj; sem eles nao ha como ligar o plano ao municipio certo (10.3)`,
        'schema_changed',
        false,
      );
    }
    return { idBeneficiario: id, nome, cnpj, uf: texto(b['uf_beneficiario']), idEnte: inteiro(b['id_ente']) };
  });
  return { beneficiarios, ...envelope(raiz) };
}

// ---------------------------------------------------------------------------
// Plano de acao
// ---------------------------------------------------------------------------

/**
 * O que o produto usa de cada plano de acao. Nao e a resposta inteira.
 *
 * Campos da fonte DELIBERADAMENTE ausentes desta interface, para que nao entrem
 * no banco nem na tela por descuido:
 *
 *  - dados bancarios (`numero_conta_plano_acao`, `numero_agencia_plano_acao`,
 *    `dv_*`, `id_agencia_conta`). A conta e de ente publico e o dado e aberto,
 *    mas nenhuma pergunta que este produto responde precisa do numero da conta.
 *    Guardar o que nao se usa so cria superficie de vazamento;
 *  - `email_camara`. E endereco de contato de terceiro; vale a mesma regra.
 *
 * Se alguma pergunta passar a exigir esses campos, eles voltam com decisao
 * registrada — nao por serem faceis de copiar.
 */
export interface PlanoAcao {
  /** Identificador estavel da fonte. Chave de deduplicacao (13.3). */
  readonly idPlanoAcao: number;
  readonly codigoPlanoAcao: string;
  readonly anoPlanoAcao: number | null;
  readonly modalidade: string | null;
  readonly situacao: string | null;
  /** Unica data que a fonte fornece para o plano. Nao ha data de publicacao. */
  readonly dataAceite: string | null;
  readonly nomeParlamentar: string | null;
  /** Identificador da emenda: e por ele que se liga, nao pelo nome (10.3). */
  readonly numeroEmenda: string | null;
  readonly codigoEmendaFormatado: string | null;
  readonly anoEmenda: number | null;
  readonly codigoParlamentar: number | null;
  readonly categoriaDespesa: string | null;
  readonly areasPoliticasPublicas: string | null;
  readonly programacaoOrcamentaria: string | null;
  readonly motivoImpedimento: string | null;
  readonly nomeObjeto: string | null;
  readonly detalhamentoObjeto: string | null;
  readonly idBeneficiario: number | null;
  readonly idPrograma: number | null;
  /** Em centavos, exato. `null` quando a fonte nao informou ou nao coube. */
  readonly custeioCentavos: bigint | null;
  readonly investimentoCentavos: bigint | null;
  /** Soma de custeio e investimento, exata. `null` se qualquer parcela for nula. */
  readonly totalCentavos: bigint | null;
  /** Motivo de algum valor ter ficado nulo. Nunca zero no lugar de ausencia (10.4). */
  readonly ressalvaValor: string | null;
}

export interface PaginaPlanosAcao extends Envelope {
  readonly planos: readonly PlanoAcao[];
}

/**
 * Le um valor monetario da fonte separando tres casos que nao podem virar o
 * mesmo numero: ausente, presente-e-zero, e presente-mas-nao-cabe-em-centavos.
 *
 * Zero declarado pela fonte E um valor — nestes planos, `valor_custeio` vem
 * 0.0 porque a emenda e toda de investimento. Tratar esse zero como ausencia
 * seria tao errado quanto o contrario, que e o que o 10.4 proibe.
 */
function valor(bruto: unknown, campo: string): { centavos: bigint | null; ressalva: string | null } {
  if (bruto === null || bruto === undefined) {
    return { centavos: null, ressalva: `${campo} ausente na fonte` };
  }
  const centavos = centavosExatos(bruto);
  if (centavos === null) {
    return { centavos: null, ressalva: `${campo} ${String(bruto)} nao cabe em centavos exatos` };
  }
  return { centavos, ressalva: null };
}

export function parsePaginaPlanosAcao(corpo: unknown): PaginaPlanosAcao {
  const { raiz, dados } = listaDeDados(corpo, 'planos-acao-especiais');

  const planos = dados.map((item, i): PlanoAcao => {
    if (item === null || typeof item !== 'object') {
      throw new ConnectorError(`plano de acao ${i} nao e um objeto`, 'schema_changed', false);
    }
    const p = item as Bruto;
    const id = inteiro(p['id_plano_acao']);
    if (id === null) {
      throw new ConnectorError(
        `plano de acao ${i} sem id_plano_acao; sem identificador estavel a deduplicacao falha (13.3)`,
        'schema_changed',
        false,
      );
    }
    const codigo = texto(p['codigo_plano_acao']);
    if (codigo === null) {
      throw new ConnectorError(`plano de acao ${id} sem codigo_plano_acao`, 'schema_changed', false);
    }

    const custeio = valor(p['valor_custeio_plano_acao'], 'valor_custeio_plano_acao');
    const investimento = valor(p['valor_investimento_plano_acao'], 'valor_investimento_plano_acao');
    const ressalvas = [custeio.ressalva, investimento.ressalva].filter((r): r is string => r !== null);

    // A soma so existe quando as DUAS parcelas sao exatas. Somar com uma
    // parcela desconhecida produziria um total menor que o real, com cara de
    // numero conferido.
    const total =
      custeio.centavos === null || investimento.centavos === null
        ? null
        : custeio.centavos + investimento.centavos;

    const numeroEmenda = p['numero_emenda_parlamentar_plano_acao'];

    return {
      idPlanoAcao: id,
      codigoPlanoAcao: codigo,
      anoPlanoAcao: inteiro(p['ano_plano_acao']),
      modalidade: texto(p['modalidade_plano_acao']),
      situacao: texto(p['situacao_plano_acao']),
      dataAceite: soData(p['data_aceite_plano_acao']),
      nomeParlamentar: texto(p['nome_parlamentar_emenda_plano_acao']),
      // Vem como numero (202023760004); vira texto porque e identificador, nao
      // quantidade — e identificador nunca deve ser somado nem arredondado.
      numeroEmenda: typeof numeroEmenda === 'number' ? String(numeroEmenda) : texto(numeroEmenda),
      codigoEmendaFormatado: texto(p['codigo_emenda_parlamentar_formatado_plano_acao']),
      anoEmenda: inteiro(p['ano_emenda_parlamentar_plano_acao']),
      codigoParlamentar: inteiro(p['codigo_parlamentar_emenda_plano_acao']),
      categoriaDespesa: texto(p['categoria_despesa_plano_acao']),
      areasPoliticasPublicas: texto(p['codigo_descricao_areas_politicas_publicas_plano_acao']),
      programacaoOrcamentaria: texto(p['descricao_programacao_orcamentaria_plano_acao']),
      motivoImpedimento: texto(p['motivo_impedimento_plano_acao']),
      nomeObjeto: texto(p['nome_objeto']),
      detalhamentoObjeto: texto(p['detalhamento_objeto']),
      idBeneficiario: inteiro(p['id_beneficiario']),
      idPrograma: inteiro(p['id_programa']),
      custeioCentavos: custeio.centavos,
      investimentoCentavos: investimento.centavos,
      totalCentavos: total,
      ressalvaValor: ressalvas.length === 0 ? null : ressalvas.join('; '),
    };
  });

  return { planos, ...envelope(raiz) };
}

/**
 * Descricao do objeto do plano.
 *
 * A fonte traz `nome_objeto` e `detalhamento_objeto` VAZIOS nos planos deste
 * municipio. Quando estao vazios este conector NAO inventa um objeto a partir
 * da area de politica publica: a area diz o setor, nao diz o que foi feito.
 * Devolve `null`, e quem chama deixa de emitir a afirmacao.
 */
export function objetoDoPlano(p: PlanoAcao): string | null {
  return p.nomeObjeto ?? p.detalhamentoObjeto;
}

/**
 * Texto do documento guardado para o plano.
 *
 * E o que a busca em portugues indexa e o que a evidencia cita, entao precisa
 * conter aquilo por que alguem procura — o parlamentar, a emenda, a area, a
 * dotacao — em vez de JSON cru.
 *
 * A frase sobre o estagio do dinheiro nao e enfeite: um plano de acao aceito
 * diz que o recurso foi DESTINADO, nao que foi pago nem recebido (11.1). O
 * texto que alguem le tem de dizer isso, porque e a confusao mais provavel.
 */
export function textoDoPlano(p: PlanoAcao): string {
  const reais = (c: bigint | null): string | null =>
    c === null ? null : (Number(c) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const linhas = [
    `Plano de acao ${p.codigoPlanoAcao}${p.anoPlanoAcao === null ? '' : ` (${p.anoPlanoAcao})`}`,
    'Transferencia especial (emenda parlamentar) para o municipio beneficiario.',
    p.situacao === null ? null : `Situacao: ${p.situacao}`,
    p.modalidade === null ? null : `Modalidade: ${p.modalidade}`,
    p.dataAceite === null ? null : `Aceite: ${p.dataAceite}`,
    p.nomeParlamentar === null ? null : `Parlamentar da emenda: ${p.nomeParlamentar}`,
    p.codigoEmendaFormatado === null ? null : `Emenda: ${p.codigoEmendaFormatado}`,
    p.numeroEmenda === null ? null : `Numero da emenda: ${p.numeroEmenda}`,
    p.categoriaDespesa === null ? null : `Categoria de despesa: ${p.categoriaDespesa}`,
    p.areasPoliticasPublicas === null ? null : `Area de politica publica: ${p.areasPoliticasPublicas}`,
    reais(p.investimentoCentavos) === null ? null : `Valor de investimento: ${reais(p.investimentoCentavos)}`,
    reais(p.custeioCentavos) === null ? null : `Valor de custeio: ${reais(p.custeioCentavos)}`,
    reais(p.totalCentavos) === null ? null : `Valor total do plano: ${reais(p.totalCentavos)}`,
    p.motivoImpedimento === null ? null : `Motivo de impedimento: ${p.motivoImpedimento}`,
    objetoDoPlano(p) === null ? null : `Objeto: ${objetoDoPlano(p)}`,
    `Identificador do plano no Transferegov: ${p.idPlanoAcao}`,
    '',
    p.programacaoOrcamentaria === null ? null : `Programacao orcamentaria: ${p.programacaoOrcamentaria}`,
    '',
    'Valor destinado pelo plano de acao. Nao e valor empenhado, transferido nem pago.',
  ];
  return linhas.filter((l): l is string => l !== null).join('\n');
}

/** Titulo legivel, usado na busca e nos cartoes. */
export function tituloDoPlano(p: PlanoAcao): string {
  const inicio = `Plano de acao ${p.codigoPlanoAcao}`;
  const assunto = objetoDoPlano(p) ?? p.areasPoliticasPublicas ?? 'transferencia especial';
  const corte = assunto.length > 100 ? `${assunto.slice(0, 97)}...` : assunto;
  return `${inicio} — ${corte}`;
}
