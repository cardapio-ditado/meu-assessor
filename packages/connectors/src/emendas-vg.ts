/** Leitura do portal municipal de emendas parlamentares (F03). */
export const PORTAL_EMENDAS_URL = 'https://emendas.varzeagrande.mt.gov.br/portal/emendas';

export interface EmendaVg {
  readonly id: string;
  readonly codigo: string;
  readonly exercicio: number;
  readonly status: string;
  readonly esfera: string;
  readonly objeto: string;
  readonly tipo: string | null;
  readonly formaRepasse: string | null;
  readonly parlamentar: string | null;
  readonly partido: string | null;
  readonly atoNormativo: string | null;
  readonly loaCredito: string | null;
  readonly orgaoExecutor: string | null;
  readonly unidadeGestora: string | null;
  readonly localidade: string | null;
  readonly beneficiarioFinal: string | null;
  readonly processo: string | null;
  readonly instrumentoJuridico: string | null;
  readonly valorOrcado: string | null;
  readonly valorEmpenhado: string | null;
  readonly valorPago: string | null;
  readonly atualizadoEm: string | null;
  readonly url: string;
  readonly documentos: readonly string[];
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_all, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function clean(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function optional(value: string | null): string | null {
  if (value === null) return null;
  const result = clean(value);
  return result === '' || result === '-' ? null : result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definition(html: string, label: string): string | null {
  const pattern = new RegExp(`<dt[^>]*>\\s*${escapeRegex(label)}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, 'i');
  return optional(pattern.exec(html)?.[1] ?? null);
}

function amountAfter(html: string, label: string): string | null {
  const pattern = new RegExp(`<p[^>]*>\\s*${escapeRegex(label)}\\s*</p>\\s*<p[^>]*>([\\s\\S]*?)</p>`, 'i');
  const raw = optional(pattern.exec(html)?.[1] ?? null);
  if (raw === null || !/R\$/.test(raw)) return null;
  const normalized = raw.replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.');
  return /^-?\d+(?:\.\d{1,2})?$/.test(normalized) ? Number(normalized).toFixed(2) : null;
}

export function linksDeEmendas(html: string): string[] {
  const ids = [...html.matchAll(/href=["'](?:https?:\/\/[^"']+)?\/portal\/emendas\/(\d+)["']/gi)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)].map((id) => `${PORTAL_EMENDAS_URL}/${id}`);
}

export function totalDeEmendas(html: string): number | null {
  const match = /(\d+)\s+resultado\(s\)/i.exec(clean(html));
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function paginasDeEmendas(html: string): number {
  const pages = [...html.matchAll(/[?&]page=(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return Math.max(1, ...pages);
}

export function parseEmendaVg(html: string, url: string): EmendaVg {
  const id = /\/portal\/emendas\/(\d+)/.exec(url)?.[1];
  const codigo = optional(/<span[^>]*font-mono[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? null);
  const exercicio = /Exercício\s+(\d{4})/i.exec(clean(html))?.[1];
  const objeto = optional(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? null);
  if (id === undefined || codigo === null || exercicio === undefined || objeto === null) {
    throw new Error(`estrutura inesperada na pagina de emenda ${url}`);
  }

  const headerText = clean(html.slice(0, html.indexOf('<h1')));
  const esfera = /\b(Federal|Estadual|Municipal)\b/i.exec(headerText)?.[1] ?? definition(html, 'Esfera');
  const knownStatus = /\b(Não Iniciada|Em Andamento|Concluída|Cancelada|Suspensa)\b/i.exec(headerText)?.[1];
  if (esfera === null || esfera === undefined || knownStatus === undefined) {
    throw new Error(`cabecalho incompleto na pagina de emenda ${url}`);
  }

  const updated = /Última atualização:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(clean(html));
  const documentos = [...html.matchAll(/href=["'](https:\/\/emendas\.varzeagrande\.mt\.gov\.br\/storage\/arquivos_emendas\/[^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);

  return {
    id,
    codigo,
    exercicio: Number(exercicio),
    status: knownStatus,
    esfera,
    objeto,
    tipo: definition(html, 'Tipo da Emenda'),
    formaRepasse: definition(html, 'Forma de Repasse'),
    parlamentar: definition(html, 'Parlamentar'),
    partido: definition(html, 'Partido'),
    atoNormativo: definition(html, 'Ato Normativo'),
    loaCredito: definition(html, 'LOA / Crédito'),
    orgaoExecutor: definition(html, 'Órgão Executor'),
    unidadeGestora: definition(html, 'Unidade Gestora'),
    localidade: definition(html, 'Localidade'),
    beneficiarioFinal: definition(html, 'Beneficiário Final'),
    processo: definition(html, 'Nº Processo'),
    instrumentoJuridico: definition(html, 'Instrumento Jurídico'),
    valorOrcado: amountAfter(html, 'Valor Orçado'),
    valorEmpenhado: amountAfter(html, 'Valor Empenhado'),
    valorPago: amountAfter(html, 'Valor Pago'),
    atualizadoEm: updated === null ? null : `${updated[3]}-${updated[2]}-${updated[1]}`,
    url,
    documentos: [...new Set(documentos)],
  };
}

export function textoDaEmenda(e: EmendaVg): string {
  const fields: [string, string | number | null][] = [
    ['Código', e.codigo], ['Exercício', e.exercicio], ['Situação', e.status],
    ['Esfera', e.esfera], ['Objeto', e.objeto], ['Tipo da emenda', e.tipo],
    ['Forma de repasse', e.formaRepasse], ['Parlamentar', e.parlamentar],
    ['Partido', e.partido], ['Órgão executor', e.orgaoExecutor],
    ['Unidade gestora', e.unidadeGestora], ['Localidade', e.localidade],
    ['Beneficiário final', e.beneficiarioFinal], ['Processo', e.processo],
    ['Instrumento jurídico', e.instrumentoJuridico], ['Valor orçado (R$)', e.valorOrcado],
    ['Valor empenhado (R$)', e.valorEmpenhado], ['Valor pago (R$)', e.valorPago],
    ['Última atualização', e.atualizadoEm],
  ];
  return fields.filter(([, value]) => value !== null).map(([label, value]) => `${label}: ${value}`).join('\n');
}
