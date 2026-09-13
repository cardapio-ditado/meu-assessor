/**
 * Conector do Diario Oficial de Varzea Grande (fonte F04).
 *
 * A estrutura saiu da resposta REAL do portal, lida em 2026-09-13: o site e uma
 * aplicacao Laravel/Livewire que renderiza a listagem no HTML inicial, entao a
 * leitura e de marcacao, nao de API. Nenhum endereco aqui foi montado por
 * padrao deduzido (8.3).
 *
 * Tres coisas descobertas em execucao, nao supostas:
 *
 *  - o NUMERO da edicao NAO e identificador unico. Na amostra real, a edicao
 *    538 aparece duas vezes no mesmo dia, uma "Normal" e outra "Suplemento",
 *    com enderecos diferentes. Deduplicar por numero fundiria as duas e uma
 *    sumiria (13.3). A chave estavel e o id interno de `/edicao/{id}`;
 *  - o nome do arquivo PDF nao e derivavel da data: `013_edicao_539_DOM.pdf`
 *    esta na pasta `07-Julho` e a edicao e de 10/07/2026 — o `013` e o decimo
 *    terceiro arquivo do mes, nao o dia. Por isso o endereco do PDF e LIDO da
 *    pagina da edicao;
 *  - o PDF tem texto nativo (24 paginas, 20 mapas `ToUnicode`, 7127 operadores
 *    de texto na edicao 539). Nao ha OCR neste conector, e o 13.2 agradece.
 *
 * Este modulo e PURO: le marcacao e normaliza. Nao faz requisicao, nao extrai
 * PDF e nao toca no banco.
 */
import { ConnectorError } from './http.ts';

export const DIARIO_VG_BASE = 'https://diariooficial.varzeagrande.mt.gov.br';

export function urlListagem(): string {
  return `${DIARIO_VG_BASE}/edicoes`;
}

/** Uma edicao anunciada na listagem. Ainda sem o endereco do PDF. */
export interface EdicaoListada {
  /** Id interno do portal. Chave de deduplicacao (13.3). */
  readonly id: string;
  /** Numero impresso da edicao. NAO e unico: ver o comentario do modulo. */
  readonly numero: string;
  /** yyyy-MM-dd */
  readonly data: string;
  /** "Normal", "Suplemento", ... conforme a fonte escreve. */
  readonly tipo: string | null;
  readonly titulo: string;
  readonly urlEdicao: string;
}

function paraIso(ddmmaaaa: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmaaaa.trim());
  if (m === null) {
    throw new ConnectorError(
      `data "${ddmmaaaa}" fora do formato dd/mm/aaaa usado pelo portal`,
      'schema_changed',
      false,
    );
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Remove marcacao e normaliza entidades comuns de uma celula. */
function textoDaCelula(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Le a listagem de edicoes.
 *
 * Uma linha sem os campos que identificam a edicao PARA a leitura em vez de ser
 * pulada: o 13.4 pede que mudanca de marcacao interrompa a coleta, porque um
 * conjunto silenciosamente menor parece sucesso e some no relatorio.
 */
export function parseListagem(html: string): readonly EdicaoListada[] {
  const linhas = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const edicoes: EdicaoListada[] = [];

  for (const linha of linhas) {
    // O cabecalho da tabela usa <th>; so as linhas de dado interessam.
    if (!linha.includes('<td')) continue;

    const numeroM = /<td class="numero">([^<]*)<\/td>/.exec(linha);
    const linkM = /<a\s+href="([^"]*\/edicao\/(\d+))"/.exec(linha);
    if (numeroM === null && linkM === null) continue;

    if (numeroM === null || linkM === null) {
      throw new ConnectorError(
        'linha da listagem do diario sem numero ou sem link da edicao; a marcacao do portal mudou',
        'schema_changed',
        false,
      );
    }

    const celulas = [...linha.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map((m) =>
      textoDaCelula(m[1] ?? ''),
    );
    // Ordem observada: numero, data, tipo, titulo, acoes.
    const data = celulas[1] ?? '';
    const tipo = celulas[2] ?? '';
    const titulo = celulas[3] ?? '';

    const id = linkM[2];
    const urlEdicao = linkM[1];
    const numero = textoDaCelula(numeroM[1] ?? '');
    if (id === undefined || urlEdicao === undefined || numero === '') {
      throw new ConnectorError('linha da listagem do diario sem id ou numero legivel', 'schema_changed', false);
    }

    edicoes.push({
      id,
      numero,
      data: paraIso(data),
      tipo: tipo === '' ? null : tipo,
      titulo: titulo === '' ? `Diario Oficial de Varzea Grande, edicao ${numero}` : titulo,
      urlEdicao,
    });
  }

  if (edicoes.length === 0) {
    throw new ConnectorError(
      'listagem do diario sem nenhuma edicao legivel; a marcacao do portal mudou ou a pagina veio vazia',
      'schema_changed',
      false,
    );
  }
  return edicoes;
}

/**
 * Encontra o endereco do PDF na pagina de uma edicao.
 *
 * Le o link em vez de montar o caminho. O nome do arquivo do portal mistura
 * pasta por mes com um contador que NAO e o dia, entao qualquer padrao deduzido
 * acertaria em algumas edicoes e baixaria o arquivo errado em outras — baixar
 * o diario do dia errado e pior do que nao baixar.
 */
export function urlDoPdf(htmlDaEdicao: string, base: string = DIARIO_VG_BASE): string {
  const achados = new Set<string>();
  for (const m of htmlDaEdicao.matchAll(/href="([^"]+\.pdf)"/gi)) {
    const bruto = m[1];
    if (bruto === undefined) continue;
    try {
      achados.add(new URL(bruto, base).toString());
    } catch {
      // Endereco ilegivel nao entra.
    }
  }
  const lista = [...achados];
  if (lista.length === 0) {
    throw new ConnectorError('pagina da edicao sem link de PDF', 'schema_changed', false);
  }
  if (lista.length > 1) {
    throw new ConnectorError(
      `pagina da edicao com ${lista.length} PDFs (${lista.join(', ')}); escolher um seria adivinhar qual e a edicao`,
      'schema_changed',
      false,
    );
  }
  const unico = lista[0];
  if (unico === undefined) throw new ConnectorError('PDF ausente apos a verificacao', 'schema_changed', false);
  return unico;
}

/** Identificador externo estavel do documento (13.3). */
export function idExterno(e: EdicaoListada): string {
  return `edicao-${e.id}`;
}

/**
 * Titulo legivel da edicao.
 *
 * Inclui o tipo porque "edicao 538" sozinho e ambiguo: ha duas com esse numero
 * no mesmo dia, e quem le a lista precisa distinguir uma da outra.
 */
export function tituloDaEdicao(e: EdicaoListada): string {
  const partes = [`Diario Oficial de Varzea Grande, edicao ${e.numero}`];
  if (e.tipo !== null && e.tipo.toLowerCase() !== 'normal') partes.push(`(${e.tipo})`);
  partes.push(`- ${e.data.split('-').reverse().join('/')}`);
  return partes.join(' ');
}

/**
 * Monta o texto guardado da edicao, com marcacao de pagina.
 *
 * As marcas `[pagina N]` existem para que a evidencia possa apontar ONDE, num
 * documento de dezenas de paginas, esta o trecho citado (12.1). Sem elas, a
 * evidencia de uma edicao inteira seria "esta em algum lugar do diario", que
 * nao e ancoragem nenhuma.
 */
export function textoDaEdicao(
  e: EdicaoListada,
  paginas: readonly { readonly numero: number; readonly texto: string }[],
): string {
  const cabecalho = [
    tituloDaEdicao(e),
    `Numero da edicao: ${e.numero}`,
    `Data de publicacao: ${e.data}`,
    e.tipo === null ? null : `Tipo: ${e.tipo}`,
    `Identificador da edicao no portal: ${e.id}`,
  ].filter((l): l is string => l !== null);

  const corpo = paginas.map((p) => `[pagina ${p.numero}]\n${p.texto}`);
  return [...cabecalho, '', ...corpo].join('\n');
}

/**
 * Encontra a pagina onde um trecho aparece, para ancorar a evidencia.
 *
 * Devolve `null` quando nao acha: e melhor uma evidencia que diz "edicao X" do
 * que uma que afirma uma pagina errada.
 */
export function paginaDoTrecho(
  paginas: readonly { readonly numero: number; readonly texto: string }[],
  trecho: string,
): number | null {
  const alvo = trecho.replace(/\s+/g, ' ').trim().toLowerCase();
  if (alvo === '') return null;
  for (const p of paginas) {
    if (p.texto.replace(/\s+/g, ' ').toLowerCase().includes(alvo)) return p.numero;
  }
  return null;
}
