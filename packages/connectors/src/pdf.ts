/**
 * Extracao de texto de PDF, por texto NATIVO (13.2).
 *
 * Por que uma biblioteca, e nao um extrator proprio:
 *
 * O diagnostico da edicao 539 do Diario Oficial de Varzea Grande (execucao
 * 34763480181) mostrou 24 paginas, 153 `/Font`, 20 `/FontFile2` e — o ponto
 * decisivo — 20 `/ToUnicode`. Fonte embutida em subconjunto nao usa ASCII nos
 * fluxos: usa indice de glifo, e so o mapa `ToUnicode` diz qual caractere e
 * qual. Um extrator ingenuo, que puxa os literais entre parenteses, acerta as
 * fontes de codificacao padrao e devolve LIXO PLAUSIVEL nas outras.
 *
 * Lixo plausivel e o pior desfecho possivel para este produto: a evidencia do
 * 12.1 e um trecho ancorado que alguem vai ler e conferir. Texto embaralhado que
 * parece texto passa por revisao e vira citacao falsa.
 *
 * Por isso o `pdfjs-dist`, que implementa CMap e ToUnicode. Nao ha OCR aqui e
 * nao deve haver: OCR e ultimo recurso (13.2), e esta fonte nao precisa.
 */

/** Uma pagina extraida, com o numero que ela ocupa no documento. */
export interface PaginaPdf {
  readonly numero: number;
  readonly texto: string;
}

export interface TextoPdf {
  readonly paginas: readonly PaginaPdf[];
  /** Texto completo, paginas separadas por quebra dupla. */
  readonly texto: string;
  readonly totalPaginas: number;
  /**
   * Paginas que nao produziram nenhum caractere. Ficam registradas em vez de
   * somem: pagina muda pode ser um encarte de imagem, e quem le o relatorio
   * precisa saber que aquele pedaco do diario NAO foi lido (9.3).
   */
  readonly paginasSemTexto: readonly number[];
}

interface ItemTexto {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/**
 * Junta os pedacos de uma pagina em texto legivel.
 *
 * O PDF emite texto em fragmentos separados por ajuste de espacamento — no
 * diario, "Flavia Pe" e "sen More" e "tti de " sao tres itens da mesma linha.
 * Concatenar sem cuidado cola palavras; inserir espaco entre todos separa
 * silabas. A pista confiavel e `hasEOL`, que o proprio pdfjs calcula a partir
 * da posicao: fim de linha vira quebra, o resto e concatenacao direta.
 */
function juntarItens(itens: readonly ItemTexto[]): string {
  let saida = '';
  for (const item of itens) {
    saida += item.str ?? '';
    if (item.hasEOL === true) saida += '\n';
  }
  return saida
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extrai o texto de um PDF em memoria.
 *
 * `maxPaginas` existe porque uma edicao de diario pode ter centenas de paginas
 * e a coleta nao deve travar num documento anomalo; quando o limite corta,
 * quem chama fica sabendo pela contagem e registra a ressalva.
 */
export async function extrairTextoPdf(
  dados: Buffer,
  opcoes: { readonly maxPaginas?: number } = {},
): Promise<TextoPdf> {
  // Importacao dinamica: o pdfjs e ESM e so e carregado por quem extrai PDF,
  // nao por todo processo que importa um conector.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const tarefa = pdfjs.getDocument({
    // Copia porque o pdfjs assume posse do buffer e o esvazia ao terminar;
    // sem a copia, quem chamou perde os bytes que ainda vai querer para o hash.
    data: new Uint8Array(dados),
    // Sem rede durante a extracao: o coletor ja baixou o que precisava, e um
    // documento de fonte externa nao deve poder puxar recurso por conta
    // propria (20.4). As fontes deste diario vem embutidas no proprio arquivo.
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
  });
  const documento = await tarefa.promise;

  const total = documento.numPages;
  const limite = Math.min(total, opcoes.maxPaginas ?? total);
  const paginas: PaginaPdf[] = [];
  const semTexto: number[] = [];

  for (let n = 1; n <= limite; n += 1) {
    const pagina = await documento.getPage(n);
    const conteudo = await pagina.getTextContent();
    const texto = juntarItens(conteudo.items as ItemTexto[]);
    if (texto === '') semTexto.push(n);
    else paginas.push({ numero: n, texto });
    pagina.cleanup();
  }
  await tarefa.destroy();

  return {
    paginas,
    texto: paginas.map((p) => p.texto).join('\n\n'),
    totalPaginas: total,
    paginasSemTexto: semTexto,
  };
}
