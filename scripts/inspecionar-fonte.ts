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
 */
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

const tipo = resposta.contentType ?? '';
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
