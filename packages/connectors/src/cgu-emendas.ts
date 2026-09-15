/**
 * Conector da API de emendas parlamentares da CGU (F07).
 *
 * Contrato observado em 2026-09-15 no OpenAPI oficial e em respostas reais.
 * A autenticacao pertence ao transporte; nenhuma chave entra nos objetos
 * retornados, nos documentos ou nos parametros persistidos.
 */
import { ConnectorError } from './http.ts';

export const CGU_API_BASE = 'https://api.portaldatransparencia.gov.br/api-de-dados';

type Bruto = Record<string, unknown>;

export interface EmendaCgu {
  readonly codigo: string;
  readonly ano: number;
  readonly tipo: string | null;
  readonly autor: string | null;
  readonly numero: string | null;
  readonly localidade: string | null;
  readonly funcao: string | null;
  readonly subfuncao: string | null;
  readonly valorEmpenhado: string | null;
  readonly valorLiquidado: string | null;
  readonly valorPago: string | null;
  readonly valorRestoInscrito: string | null;
  readonly valorRestoCancelado: string | null;
  readonly valorRestoPago: string | null;
}

export interface DocumentoEmendaCgu {
  readonly id: string;
  readonly data: string | null;
  readonly fase: string | null;
  readonly codigo: string;
  readonly codigoResumido: string | null;
  readonly especieTipo: string | null;
  readonly tipoEmenda: string | null;
}

function objeto(value: unknown): Bruto | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Bruto : null;
}

function texto(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const limpo = value.replace(/\s+/g, ' ').trim();
  return limpo === '' || limpo === '-' ? null : limpo;
}

function inteiro(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Converte "1.234.567,89" em decimal SQL exato, sem float. */
export function dinheiroCgu(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? String(value) : texto(value);
  if (raw === null) return null;
  const semSimbolo = raw.replace(/R\$/gi, '').replace(/\s/g, '');
  const normalizado = semSimbolo.includes(',')
    ? semSimbolo.replace(/\./g, '').replace(',', '.')
    : semSimbolo;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalizado)) {
    throw new ConnectorError(`valor monetario inesperado na CGU: ${raw}`, 'schema_changed', false);
  }
  const [inteira = '0', decimal = ''] = normalizado.split('.');
  return `${inteira}.${decimal.padEnd(2, '0')}`;
}

export function dataCgu(value: unknown): string | null {
  const raw = texto(value);
  if (raw === null) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (match === null) {
    throw new ConnectorError(`data inesperada na CGU: ${raw}`, 'schema_changed', false);
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function urlEmendasCgu(codigo: string, pagina = 1): string {
  if (!/^20\d{10}$/.test(codigo)) {
    throw new ConnectorError(`codigo de emenda invalido: ${codigo}`, 'schema_changed', false);
  }
  const url = new URL(`${CGU_API_BASE}/emendas`);
  url.searchParams.set('codigoEmenda', codigo);
  url.searchParams.set('pagina', String(pagina));
  return url.toString();
}

export function urlDocumentosEmendaCgu(codigo: string, pagina = 1): string {
  if (!/^20\d{10}$/.test(codigo)) {
    throw new ConnectorError(`codigo de emenda invalido: ${codigo}`, 'schema_changed', false);
  }
  const url = new URL(`${CGU_API_BASE}/emendas/documentos/${encodeURIComponent(codigo)}`);
  url.searchParams.set('pagina', String(pagina));
  return url.toString();
}

export function parseEmendasCgu(body: unknown): EmendaCgu[] {
  if (!Array.isArray(body)) {
    throw new ConnectorError('CGU/emendas deixou de retornar uma lista', 'schema_changed', false);
  }
  return body.map((item, index) => {
    const row = objeto(item);
    if (row === null) throw new ConnectorError(`emenda CGU ${index} nao e objeto`, 'schema_changed', false);
    const codigo = texto(row['codigoEmenda']);
    const ano = inteiro(row['ano']);
    if (codigo === null || ano === null) {
      throw new ConnectorError(`emenda CGU ${index} sem codigo ou ano`, 'schema_changed', false);
    }
    return {
      codigo,
      ano,
      tipo: texto(row['tipoEmenda']),
      autor: texto(row['nomeAutor']) ?? texto(row['autor']),
      numero: texto(row['numeroEmenda']),
      localidade: texto(row['localidadeDoGasto']),
      funcao: texto(row['funcao']),
      subfuncao: texto(row['subfuncao']),
      valorEmpenhado: dinheiroCgu(row['valorEmpenhado']),
      valorLiquidado: dinheiroCgu(row['valorLiquidado']),
      valorPago: dinheiroCgu(row['valorPago']),
      valorRestoInscrito: dinheiroCgu(row['valorRestoInscrito']),
      valorRestoCancelado: dinheiroCgu(row['valorRestoCancelado']),
      valorRestoPago: dinheiroCgu(row['valorRestoPago']),
    };
  });
}

export function parseDocumentosEmendaCgu(body: unknown): DocumentoEmendaCgu[] {
  if (!Array.isArray(body)) {
    throw new ConnectorError('CGU/emendas/documentos deixou de retornar uma lista', 'schema_changed', false);
  }
  return body.map((item, index) => {
    const row = objeto(item);
    if (row === null) throw new ConnectorError(`documento CGU ${index} nao e objeto`, 'schema_changed', false);
    const id = inteiro(row['id']);
    const codigo = texto(row['codigoDocumento']);
    if (id === null || codigo === null) {
      throw new ConnectorError(`documento CGU ${index} sem id ou codigo`, 'schema_changed', false);
    }
    return {
      id: String(id),
      data: dataCgu(row['data']),
      fase: texto(row['fase']),
      codigo,
      codigoResumido: texto(row['codigoDocumentoResumido']),
      especieTipo: texto(row['especieTipo']),
      tipoEmenda: texto(row['tipoEmenda']),
    };
  });
}

function linhaMoeda(label: string, valor: string | null, explicacao: string): string | null {
  return valor === null ? null : `${label}: R$ ${valor} — ${explicacao}`;
}

/** Texto pronto para leitura e busca; nao e JSON cru. */
export function textoEmendaCgu(e: EmendaCgu, documentos: number): string {
  const linhas: Array<string | null> = [
    `Emenda parlamentar federal ${e.codigo}, exercício ${e.ano}.`,
    e.autor === null ? null : `Autor indicado pela CGU: ${e.autor}.`,
    e.tipo === null ? null : `Tipo: ${e.tipo}.`,
    e.localidade === null ? null : `Localidade do gasto: ${e.localidade}.`,
    e.funcao === null ? null : `Área de atuação: ${e.funcao}.`,
    e.subfuncao === null ? null : `Detalhamento da área: ${e.subfuncao}.`,
    '',
    linhaMoeda('Valor empenhado', e.valorEmpenhado, 'valor reservado formalmente no orçamento'),
    linhaMoeda('Valor liquidado', e.valorLiquidado, 'despesa reconhecida após verificação da entrega ou obrigação'),
    linhaMoeda('Valor pago', e.valorPago, 'pagamento registrado pela União'),
    linhaMoeda('Restos a pagar inscritos', e.valorRestoInscrito, 'obrigação transferida para exercício seguinte'),
    linhaMoeda('Restos a pagar pagos', e.valorRestoPago, 'parcela de restos a pagar já paga'),
    linhaMoeda('Restos a pagar cancelados', e.valorRestoCancelado, 'parcela cancelada'),
    '',
    `Documentos financeiros relacionados encontrados: ${documentos}.`,
    'Os valores são posições acumuladas da CGU e não devem ser somados entre atualizações ou com outra fonte sem conciliação.',
  ];
  return linhas.filter((linha): linha is string => linha !== null).join('\n');
}

export function textoDocumentoEmendaCgu(codigoEmenda: string, d: DocumentoEmendaCgu): string {
  const linhas: Array<string | null> = [
    `Documento financeiro relacionado à emenda ${codigoEmenda}.`,
    `Código completo: ${d.codigo}.`,
    d.codigoResumido === null ? null : `Código resumido: ${d.codigoResumido}.`,
    d.fase === null ? null : `Fase da despesa: ${d.fase}.`,
    d.data === null ? null : `Data do documento: ${d.data}.`,
    d.especieTipo === null ? null : `Espécie/tipo: ${d.especieTipo}.`,
    d.tipoEmenda === null ? null : `Tipo da emenda: ${d.tipoEmenda}.`,
    'Este registro comprova a existência do documento relacionado; o valor deve ser lido da consulta financeira correspondente.',
  ];
  return linhas.filter((linha): linha is string => linha !== null).join('\n');
}
