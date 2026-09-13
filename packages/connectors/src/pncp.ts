/**
 * Conector do PNCP — contratos por data de publicacao (fonte F06).
 *
 * O endereco e os parametros vieram da especificacao OpenAPI publicada pelo
 * proprio PNCP (`/api/consulta/v3/api-docs`), lida em 2026-09-13, e a forma dos
 * registros veio de uma resposta real do orgao do piloto. Nenhum campo aqui foi
 * deduzido de memoria — e o que o 8.3 exige ("nao crie um endpoint por
 * adivinhacao").
 *
 * Este modulo e PURO: monta endereco, valida e normaliza. Nao faz requisicao e
 * nao toca no banco, para que a parte dificil — decidir o que um registro
 * significa — seja testavel contra uma amostra fixa.
 *
 * Contrato do endpoint, verbatim da especificacao:
 *
 *   GET /api/consulta/v1/contratos
 *     dataInicial    OBRIGATORIO   yyyyMMdd
 *     dataFinal      OBRIGATORIO   yyyyMMdd
 *     cnpjOrgao      opcional      somente digitos
 *     pagina         OBRIGATORIO   >= 1
 *     tamanhoPagina  opcional      o provedor recusa valores pequenos demais
 */
import { ConnectorError } from './http.ts';
// A conversao de dinheiro e a mesma em todos os conectores e mora em um so
// lugar (10.4). Reexportada porque faz parte da interface deste modulo.
import { centavosExatos } from './dinheiro.ts';

export { centavosExatos };

export const PNCP_BASE = 'https://pncp.gov.br/api/consulta/v1';

/**
 * O provedor respondeu "Tamanho de pagina invalido" para 2. O minimo nao esta
 * declarado na especificacao, entao o conector usa um valor confirmado em
 * execucao real em vez de tentar descobrir o limite as custas do portal.
 */
export const TAMANHO_PAGINA = 50;

export interface JanelaConsulta {
  /** yyyy-MM-dd */
  readonly de: string;
  /** yyyy-MM-dd */
  readonly ate: string;
}

function paraAAAAMMDD(data: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (m === null) throw new ConnectorError(`data ${data} fora do formato yyyy-MM-dd`, 'schema_changed', false);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Somente digitos: a API rejeita CNPJ pontuado. */
export function digitosCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

export function urlContratos(params: {
  readonly cnpjOrgao: string;
  readonly janela: JanelaConsulta;
  readonly pagina: number;
  readonly tamanhoPagina?: number;
}): string {
  const q = new URLSearchParams({
    dataInicial: paraAAAAMMDD(params.janela.de),
    dataFinal: paraAAAAMMDD(params.janela.ate),
    cnpjOrgao: digitosCnpj(params.cnpjOrgao),
    pagina: String(params.pagina),
    tamanhoPagina: String(params.tamanhoPagina ?? TAMANHO_PAGINA),
  });
  return `${PNCP_BASE}/contratos?${q.toString()}`;
}

/** O que o produto usa de cada contrato. Nao e a resposta inteira do PNCP. */
export interface ContratoPncp {
  /** Identificador estavel do PNCP. Chave de deduplicacao (13.3). */
  readonly numeroControlePNCP: string;
  readonly numeroContrato: string;
  readonly anoContrato: number | null;
  readonly objeto: string;
  readonly orgaoRazaoSocial: string;
  readonly orgaoCnpj: string;
  readonly unidadeNome: string | null;
  readonly municipioNome: string | null;
  readonly codigoIbge: string | null;
  readonly fornecedorNome: string | null;
  /** CNPJ ou CPF do fornecedor: vinculo por identificador, nao por nome (10.3). */
  readonly fornecedorNi: string | null;
  readonly tipoPessoa: string | null;
  readonly dataAssinatura: string | null;
  readonly vigenciaInicio: string | null;
  readonly vigenciaFim: string | null;
  readonly dataPublicacao: string | null;
  readonly processo: string | null;
  readonly tipoContrato: string | null;
  /** Em centavos, exato. `null` quando o valor nao cabe em centavos (ver abaixo). */
  readonly valorGlobalCentavos: bigint | null;
  readonly valorInicialCentavos: bigint | null;
  readonly numeroParcelas: number | null;
  /** Motivo pelo qual algum valor ficou nulo. Nunca zero no lugar de ausencia (10.4). */
  readonly ressalvaValor: string | null;
}

export interface PaginaContratos {
  readonly contratos: readonly ContratoPncp[];
  readonly totalRegistros: number;
  readonly totalPaginas: number;
  readonly paginaAtual: number;
  readonly paginasRestantes: number;
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

/** Recorta a parte de data de "2026-02-13T15:49:33" ou de "2025-07-28". */
function soData(valor: unknown): string | null {
  const t = texto(valor);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m === null ? null : (m[1] ?? null);
}

interface Bruto {
  readonly [k: string]: unknown;
}

/**
 * Valida e normaliza uma pagina de contratos.
 *
 * Falta de campo obrigatorio e `schema_changed`, nao registro ignorado: o 13.4
 * pede que mudanca de contrato pare a coleta em vez de produzir silenciosamente
 * um conjunto menor — um lote reduzido parece sucesso e some no relatorio.
 */
export function parsePaginaContratos(corpo: unknown): PaginaContratos {
  if (corpo === null || typeof corpo !== 'object') {
    throw new ConnectorError('resposta do PNCP nao e um objeto', 'schema_changed', false);
  }
  const raiz = corpo as Bruto;
  const dados = raiz['data'];
  if (!Array.isArray(dados)) {
    throw new ConnectorError('resposta do PNCP sem a lista `data`', 'schema_changed', false);
  }

  const contratos = dados.map((item, i): ContratoPncp => {
    if (item === null || typeof item !== 'object') {
      throw new ConnectorError(`registro ${i} do PNCP nao e um objeto`, 'schema_changed', false);
    }
    const c = item as Bruto;
    const id = texto(c['numeroControlePNCP']);
    if (id === null) {
      throw new ConnectorError(
        `registro ${i} do PNCP sem numeroControlePNCP; sem identificador estavel a deduplicacao falha (13.3)`,
        'schema_changed',
        false,
      );
    }
    const orgao = (c['orgaoEntidade'] ?? {}) as Bruto;
    const unidade = (c['unidadeOrgao'] ?? {}) as Bruto;
    const tipo = (c['tipoContrato'] ?? {}) as Bruto;

    const orgaoCnpj = texto(orgao['cnpj']);
    const orgaoNome = texto(orgao['razaoSocial']);
    if (orgaoCnpj === null || orgaoNome === null) {
      throw new ConnectorError(
        `registro ${id} sem orgaoEntidade.cnpj ou razaoSocial`,
        'schema_changed',
        false,
      );
    }

    const global = centavosExatos(c['valorGlobal']);
    const inicial = centavosExatos(c['valorInicial']);
    const ressalvas: string[] = [];
    if (global === null && c['valorGlobal'] !== null && c['valorGlobal'] !== undefined) {
      ressalvas.push(`valorGlobal ${String(c['valorGlobal'])} nao cabe em centavos exatos`);
    }
    if (global === null && (c['valorGlobal'] === null || c['valorGlobal'] === undefined)) {
      ressalvas.push('valorGlobal ausente na fonte');
    }

    return {
      numeroControlePNCP: id,
      numeroContrato: texto(c['numeroContratoEmpenho']) ?? '(sem numero)',
      anoContrato: typeof c['anoContrato'] === 'number' ? c['anoContrato'] : null,
      objeto: texto(c['objetoContrato']) ?? '(objeto nao informado)',
      orgaoRazaoSocial: orgaoNome,
      orgaoCnpj,
      unidadeNome: texto(unidade['nomeUnidade']),
      municipioNome: texto(unidade['municipioNome']),
      codigoIbge: texto(unidade['codigoIbge']),
      fornecedorNome: texto(c['nomeRazaoSocialFornecedor']),
      fornecedorNi: texto(c['niFornecedor']),
      tipoPessoa: texto(c['tipoPessoa']),
      dataAssinatura: soData(c['dataAssinatura']),
      vigenciaInicio: soData(c['dataVigenciaInicio']),
      vigenciaFim: soData(c['dataVigenciaFim']),
      dataPublicacao: soData(c['dataPublicacaoPncp']),
      processo: texto(c['processo']),
      tipoContrato: texto(tipo['nome']),
      valorGlobalCentavos: global,
      valorInicialCentavos: inicial,
      numeroParcelas: typeof c['numeroParcelas'] === 'number' ? c['numeroParcelas'] : null,
      ressalvaValor: ressalvas.length === 0 ? null : ressalvas.join('; '),
    };
  });

  const numero = (chave: string): number =>
    typeof raiz[chave] === 'number' ? (raiz[chave] as number) : 0;

  return {
    contratos,
    totalRegistros: numero('totalRegistros'),
    totalPaginas: numero('totalPaginas'),
    paginaAtual: numero('numeroPagina'),
    paginasRestantes: numero('paginasRestantes'),
  };
}

/**
 * Texto do documento guardado para o contrato.
 *
 * E o que a busca textual em portugues indexa e o que a evidencia cita, entao
 * precisa conter os campos pelos quais alguem procura — numero, objeto,
 * fornecedor, unidade — em vez de JSON cru.
 */
export function textoDoContrato(c: ContratoPncp): string {
  const linhas = [
    `Contrato ${c.numeroContrato}${c.anoContrato === null ? '' : `/${c.anoContrato}`}`,
    `Orgao: ${c.orgaoRazaoSocial}`,
    c.unidadeNome === null ? null : `Unidade: ${c.unidadeNome}`,
    c.fornecedorNome === null ? null : `Fornecedor: ${c.fornecedorNome}`,
    c.fornecedorNi === null ? null : `Identificacao do fornecedor: ${c.fornecedorNi}`,
    c.processo === null ? null : `Processo: ${c.processo}`,
    c.tipoContrato === null ? null : `Tipo: ${c.tipoContrato}`,
    c.dataAssinatura === null ? null : `Assinatura: ${c.dataAssinatura}`,
    c.vigenciaInicio === null || c.vigenciaFim === null
      ? null
      : `Vigencia: ${c.vigenciaInicio} a ${c.vigenciaFim}`,
    `Identificador PNCP: ${c.numeroControlePNCP}`,
    '',
    `Objeto: ${c.objeto}`,
  ];
  return linhas.filter((l): l is string => l !== null).join('\n');
}

/** Titulo legivel, usado na busca e nos cartoes. */
export function tituloDoContrato(c: ContratoPncp): string {
  const numero = `Contrato ${c.numeroContrato}${c.anoContrato === null ? '' : `/${c.anoContrato}`}`;
  const objeto = c.objeto.length > 120 ? `${c.objeto.slice(0, 117)}...` : c.objeto;
  return `${numero} — ${objeto}`;
}
