/**
 * Olhar para o que uma fonte REALMENTE devolve, antes de escrever conector.
 *
 * O 8.3 e explicito: "Nao crie um endpoint por adivinhacao" — os enderecos e os
 * campos tem que sair da documentacao oficial e da resposta real. Quem escreve
 * o parser precisa ver a resposta; este comando existe para isso, e nao para
 * coletar: ele nao grava nada no banco e nao altera situacao de fonte nenhuma.
 *
 * Restricoes que nao sao opcionais:
 *
 *  - so alcanca os dominios do catalogo. A allowlist vem de
 *    `packages/connectors/src/catalog.ts`, nao de um parametro, entao este
 *    comando nao vira um buscador de URL arbitraria dentro do CI;
 *  - passa pelo `fetchGuarded`, com bloqueio de faixa interna e revalidacao a
 *    cada redirecionamento, igual a coleta;
 *  - imprime um recorte do corpo, nao o corpo inteiro: a saida vai para um log
 *    publico de execucao.
 *
 * Uso:
 *   node --experimental-strip-types scripts/inspecionar-fonte.ts \
 *     --url https://pncp.gov.br/api/consulta/v1/... [--bytes 20000]
 *
 * Com `--endpoints`, e a especificacao sendo OpenAPI, imprime so os caminhos e
 * seus parametros — que e o que se usa para escrever o conector.
 */
import { inflateSync } from 'node:zlib';
import { SOURCE_CATALOG } from '../packages/connectors/src/catalog.ts';
import { fetchGuarded } from '../packages/connectors/src/http.ts';

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
}

const url = arg('--url');
if (url === undefined) {
  process.stderr.write('uso: --url <endereco de uma fonte do catalogo> [--bytes N]\n');
  process.exit(2);
}

const limite = Number(arg('--bytes') ?? 20_000);

// A allowlist e o catalogo. Um endereco fora dele nao e inspecionavel por aqui.
const dominios = SOURCE_CATALOG.map((s) => s.domain);
process.env['INGESTION_ALLOWED_HOSTS'] = dominios.join(',');
process.env['INGESTION_USER_AGENT'] ??=
  'MeuAssessor/0.1 (inspecao de fonte; +https://github.com/cardapio-ditado/meu-assessor)';

const host = new URL(url).hostname;
const fonte = SOURCE_CATALOG.find((s) => s.domain === host);
if (fonte === undefined) {
  process.stderr.write(
    `${host} nao esta no catalogo de fontes. Dominios inspecionaveis:\n  ${dominios.join('\n  ')}\n`,
  );
  process.exit(2);
}

const resposta = await fetchGuarded(url, { maxRetries: 1, maxBytes: 8 * 1024 * 1024 });
const corpo = resposta.body.toString('utf8');

process.stdout.write(`# Inspecao de ${fonte.code} — ${fonte.officialName}\n\n`);
process.stdout.write(`- endereco pedido: ${url}\n`);
process.stdout.write(`- endereco final: ${resposta.finalUrl}\n`);
process.stdout.write(`- status: ${resposta.status}\n`);
process.stdout.write(`- tipo: ${resposta.contentType ?? 'nao declarado'}\n`);
process.stdout.write(`- tamanho: ${resposta.body.byteLength} bytes\n\n`);

/**
 * Para JSON, a FORMA importa mais que o conteudo: quem escreve o parser precisa
 * saber quais campos existem, nao ler mil registros. O resumo vem antes do
 * recorte bruto para caber no que alguem le de um log.
 */
function forma(valor: unknown, prefixo = '', profundidade = 0): string[] {
  if (profundidade > 3) return [`${prefixo}: ...`];
  if (Array.isArray(valor)) {
    const linhas = [`${prefixo}: lista (${valor.length})`];
    if (valor.length > 0) linhas.push(...forma(valor[0], `${prefixo}[0]`, profundidade + 1));
    return linhas;
  }
  if (valor !== null && typeof valor === 'object') {
    const linhas: string[] = prefixo === '' ? [] : [`${prefixo}: objeto`];
    for (const [k, v] of Object.entries(valor)) {
      linhas.push(...forma(v, prefixo === '' ? k : `${prefixo}.${k}`, profundidade + 1));
    }
    return linhas;
  }
  const tipo = valor === null ? 'nulo' : typeof valor;
  const amostra = typeof valor === 'string' && valor.length > 60 ? `${valor.slice(0, 60)}…` : String(valor);
  return [`${prefixo}: ${tipo} = ${amostra}`];
}

/**
 * Resumo de uma especificacao OpenAPI: cada caminho, o metodo, o resumo e os
 * parametros com nome, origem, obrigatoriedade e tipo.
 *
 * E exatamente o que quem escreve conector precisa, e o que o 8.3 exige que
 * venha da documentacao em vez de memoria. Imprimir o documento inteiro nao
 * serve: alem de enterrar a informacao, a linha unica de dezenas de milhares de
 * caracteres nao sobrevive ao log de execucao.
 */
interface ParametroOpenApi {
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: { readonly type?: string; readonly format?: string };
}

function endpoints(doc: Record<string, unknown>, soCaminhos: boolean, filtro: string | null): string[] {
  const linhas: string[] = [];
  const servidores = (doc['servers'] as { url?: string }[] | undefined) ?? [];
  linhas.push(`servidores: ${servidores.map((s) => s.url ?? '?').join(', ') || '(nao declarado)'}`);
  const caminhos = (doc['paths'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [caminho, operacoes] of Object.entries(caminhos)) {
    for (const [metodo, op] of Object.entries(operacoes)) {
      const operacao = op as { summary?: string; parameters?: ParametroOpenApi[] };
      const assunto = `${caminho} ${operacao.summary ?? ''}`.toLowerCase();
      if (filtro !== null && !assunto.includes(filtro.toLowerCase())) continue;
      if (soCaminhos) {
        linhas.push(`${metodo.toUpperCase()} ${caminho}${operacao.summary === undefined ? '' : ` — ${operacao.summary}`}`);
        continue;
      }
      linhas.push('');
      linhas.push(`${metodo.toUpperCase()} ${caminho}`);
      if (operacao.summary !== undefined) linhas.push(`  ${operacao.summary}`);
      for (const par of operacao.parameters ?? []) {
        const obrigatorio = par.required === true ? 'OBRIGATORIO' : 'opcional';
        const t = par.schema?.format ?? par.schema?.type ?? '?';
        linhas.push(`  - ${par.name} (${par.in}, ${obrigatorio}, ${t})`);
      }
    }
  }
  return linhas;
}

/**
 * Links de uma pagina HTML, sem repeticao.
 *
 * Um indice de API ou de portal diz onde estao os recursos, e e isso que se
 * procura antes de escrever conector. Imprimir o HTML cru nao serve: uma pagina
 * de documentacao costuma ter um favicon embutido em base64 que sozinho ocupa
 * todo o recorte — foi o que aconteceu na primeira inspecao do Transferegov.
 */
function links(html: string, base: string): string[] {
  const achados = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const bruto = m[1];
    if (bruto === undefined) continue;
    // `data:` e ancora nao levam a lugar nenhum.
    if (bruto.startsWith('data:') || bruto.startsWith('#') || bruto.startsWith('javascript:')) continue;
    try {
      achados.add(new URL(bruto, base).toString());
    } catch {
      achados.add(bruto);
    }
  }
  return [...achados].sort();
}

/**
 * Diagnostico de um PDF, sem dependencia nenhuma.
 *
 * Serve para responder UMA pergunta antes de escrever conector de documento:
 * o PDF tem texto nativo, ou e pagina digitalizada? A resposta muda tudo — o
 * 13.2 poe OCR como ultimo recurso, e OCR nao e detalhe de implementacao, e
 * outra qualidade de extracao e outro custo.
 *
 * Nao extrai o documento: conta marcas estruturais, infla os fluxos com o zlib
 * do proprio Node e mostra um punhado de literais de texto. E o suficiente para
 * decidir com evidencia em vez de suposicao.
 */
function diagnosticoPdf(buf: Buffer): string[] {
  const linhas: string[] = [];
  linhas.push(`cabecalho: ${buf.subarray(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').trim()}`);

  // latin1 preserva byte a byte, entao contar marcas no texto nao corrompe o binario.
  const bruto = buf.toString('latin1');
  const conta = (padrao: string): number => bruto.split(padrao).length - 1;

  linhas.push(`paginas (/Type /Page): ${conta('/Type /Page') + conta('/Type/Page')}`);
  linhas.push('');
  linhas.push('marcas de TEXTO (quanto mais, melhor para extracao nativa):');
  for (const m of ['/Font', '/FontFile', '/FontFile2', '/FontFile3', '/ToUnicode']) {
    linhas.push(`  ${m}: ${conta(m)}`);
  }
  linhas.push('');
  linhas.push('marcas de IMAGEM (indicam pagina digitalizada, que exigiria OCR):');
  for (const m of ['/DCTDecode', '/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode', '/Subtype /Image']) {
    linhas.push(`  ${m}: ${conta(m)}`);
  }

  // Fluxos: inflar o que for FlateDecode e procurar operadores de texto.
  let fluxos = 0;
  let inflados = 0;
  let operadoresTj = 0;
  const amostras: string[] = [];
  let pos = 0;
  for (;;) {
    const inicio = buf.indexOf('stream', pos);
    if (inicio === -1) break;
    const fim = buf.indexOf('endstream', inicio);
    if (fim === -1) break;
    fluxos += 1;
    // Pula o EOL depois de "stream" (pode ser \r\n ou \n).
    let dados = inicio + 6;
    if (buf[dados] === 0x0d) dados += 1;
    if (buf[dados] === 0x0a) dados += 1;
    try {
      const texto = inflateSync(buf.subarray(dados, fim)).toString('latin1');
      inflados += 1;
      operadoresTj += texto.split(/\bTJ\b|\bTj\b/).length - 1;
      if (amostras.length < 12) {
        for (const m of texto.matchAll(/\(([^()\\]{4,60})\)/g)) {
          const t = m[1];
          if (t !== undefined && /[A-Za-zÀ-ÿ]{3}/.test(t)) amostras.push(t);
          if (amostras.length >= 12) break;
        }
      }
    } catch {
      // Fluxo nao comprimido ou com filtro que nao e Flate: nao e erro aqui.
    }
    pos = fim + 9;
  }

  linhas.push('');
  linhas.push(`fluxos: ${fluxos}, inflados com sucesso: ${inflados}`);
  linhas.push(`operadores de mostrar texto (Tj/TJ) nos fluxos inflados: ${operadoresTj}`);
  linhas.push('');
  linhas.push(
    operadoresTj > 0
      ? 'VEREDITO: ha texto nativo nos fluxos. Extracao sem OCR e possivel.'
      : 'VEREDITO: nenhum operador de texto encontrado. Provavel pagina digitalizada (exigiria OCR, 13.2).',
  );
  if (amostras.length > 0) {
    linhas.push('');
    linhas.push('literais de texto encontrados:');
    for (const a of amostras) linhas.push(`  ${a}`);
  }
  return linhas;
}

const tipo = resposta.contentType ?? '';
if (process.argv.includes('--pdf')) {
  process.stdout.write(`## Diagnostico do PDF\n\n\`\`\`\n${diagnosticoPdf(resposta.body).join('\n')}\n\`\`\`\n`);
  process.exit(0);
}

if (process.argv.includes('--links')) {
  const todos = links(corpo, resposta.finalUrl);
  // O filtro vale tambem para links: a listagem do Diario Oficial tem
  // centenas de enderecos, e o que interessa e um recorte. Sem ele, a
  // informacao existe e nao da para ler.
  const filtro = arg('--filtro') ?? null;
  const encontrados =
    filtro === null ? todos : todos.filter((l) => l.toLowerCase().includes(filtro.toLowerCase()));
  process.stdout.write(
    `## Links: ${encontrados.length} de ${todos.length}` +
      `${filtro === null ? '' : ` (filtro "${filtro}")`}\n\n`,
  );
  // Amostra, nao lista inteira: a contagem responde "quanto", e um punhado de
  // exemplos responde "de que forma". Despejar centenas nao responde nenhuma.
  const amostra = encontrados.length > 40 ? [...encontrados.slice(0, 20), '...', ...encontrados.slice(-20)] : encontrados;
  process.stdout.write(`\`\`\`\n${amostra.join('\n')}\n\`\`\`\n`);
  process.exit(0);
}

if (process.argv.includes('--endpoints') && tipo.includes('json')) {
  const doc = JSON.parse(corpo) as Record<string, unknown>;
  // Uma API grande nao cabe num log: `--caminhos` lista so os enderecos, e
  // `--filtro` restringe ao assunto, que e como se procura o recurso certo.
  const resumo = endpoints(doc, process.argv.includes('--caminhos'), arg('--filtro') ?? null);
  process.stdout.write(`## Endpoints declarados (${resumo.length} linhas)\n\n\`\`\`\n${resumo.join('\n')}\n\`\`\`\n`);
  process.exit(0);
}

if (tipo.includes('json')) {
  try {
    const dados: unknown = JSON.parse(corpo);
    process.stdout.write(`## Forma da resposta\n\n\`\`\`\n${forma(dados).join('\n')}\n\`\`\`\n\n`);
  } catch {
    process.stdout.write('## Forma da resposta\n\nTipo declarado e JSON, mas o corpo nao analisa.\n\n');
  }
}

process.stdout.write(
  `## Recorte do corpo (${Math.min(limite, corpo.length)} de ${corpo.length} caracteres)\n\n` +
    `\`\`\`\n${corpo.slice(0, limite)}\n\`\`\`\n`,
);
