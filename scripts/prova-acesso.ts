/**
 * Etapa E1 do 24.2: provar acesso as fontes.
 *
 * O que esta prova vale e o que ela NAO vale (C.2): alcancar a pagina de uma
 * fonte demonstra que o endereco responde de onde a sondagem rodou. Nao
 * demonstra que existe conector, nem que o recorte historico esta disponivel,
 * nem que os campos do 8.4 foram medidos. Por isso este script nunca marca
 * `connector_verified` e nunca habilita fonte alguma: ele produz evidencia
 * datada para `docs/sources/prova-de-acesso.md`, e a decisao de habilitar
 * continua sendo de operacao autorizada, apos o checklist F.1 (8.1).
 *
 * Tres cuidados que mudam o resultado:
 *
 *  1. as requisicoes passam por `fetchGuarded`, o mesmo cliente da coleta:
 *     allowlist de host, bloqueio de faixa interna, revalidacao a cada
 *     redirecionamento e limite de bytes. Sondar com um cliente mais frouxo do
 *     que o de producao mediria outra coisa;
 *  2. `robots.txt` e consultado ANTES, e um caminho proibido nao e requisitado.
 *     Ausencia de robots.txt nao e permissao para tudo, e sim ausencia de
 *     restricao declarada;
 *  3. ha CONTROLES neutros. Sem eles, um ambiente sem saida de rede produz
 *     "todos os portais bloqueados" — conclusao falsa e cara. Se os controles
 *     tambem falharem, o relatorio diz que a sondagem e inconclusiva e o
 *     processo termina com codigo 1.
 *
 * Uso:
 *   node --experimental-strip-types scripts/prova-acesso.ts
 *   node --experimental-strip-types scripts/prova-acesso.ts --json prova.json
 *
 * O relatorio legivel sai sempre na saida padrao; `--json` grava o resultado
 * estruturado da MESMA execucao. Sao dois formatos de uma sondagem, nunca duas
 * sondagens: repetir as requisicoes para gerar o segundo formato dobraria o
 * trafego no portal de um orgao publico para nao aprender nada novo.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { SOURCE_CATALOG } from '../packages/connectors/src/catalog.ts';
import { ConnectorError, fetchGuarded } from '../packages/connectors/src/http.ts';

/** Enderecos que nao pertencem a nenhuma fonte, so para medir a saida de rede. */
const CONTROLES = ['https://example.com/', 'https://www.gov.br/'] as const;

type Desfecho =
  | 'alcancado'
  | 'rejeitado'
  | 'nao_encontrado'
  | 'robots_proibe'
  | 'indisponivel'
  | 'erro_de_rede';

interface Resultado {
  readonly code: string;
  readonly nome: string;
  readonly url: string;
  readonly desfecho: Desfecho;
  readonly detalhe: string;
  readonly status: number | null;
  readonly tipo: string | null;
  readonly bytes: number | null;
  readonly ms: number;
}

/**
 * Leitura minima de robots.txt: agrupa por User-agent e devolve os prefixos
 * proibidos que se aplicam a nos. Deliberadamente conservadora — na duvida,
 * trata como proibido.
 */
function prefixosProibidos(robots: string, agente: string): string[] {
  const proibidos: string[] = [];
  let aplicavel = false;
  for (const linhaBruta of robots.split(/\r?\n/)) {
    const linha = linhaBruta.replace(/#.*$/, '').trim();
    if (linha === '') continue;
    const [campoBruto, ...resto] = linha.split(':');
    const campo = (campoBruto ?? '').toLowerCase().trim();
    const valor = resto.join(':').trim();
    if (campo === 'user-agent') {
      aplicavel = valor === '*' || agente.toLowerCase().includes(valor.toLowerCase());
      continue;
    }
    if (campo === 'disallow' && aplicavel && valor !== '') proibidos.push(valor);
  }
  return proibidos;
}

async function robotsProibe(url: string, agente: string): Promise<string | null> {
  const alvo = new URL(url);
  try {
    const robots = await fetchGuarded(new URL('/robots.txt', alvo).toString(), {
      timeoutMs: 15_000,
      maxRetries: 1,
      maxBytes: 512 * 1024,
    });
    const proibidos = prefixosProibidos(robots.body.toString('utf8'), agente);
    const caminho = alvo.pathname === '' ? '/' : alvo.pathname;
    const bate = proibidos.find((p) => (p === '/' ? caminho === '/' : caminho.startsWith(p)));
    return bate ?? null;
  } catch {
    // Sem robots.txt legivel nao ha restricao DECLARADA. Nao e carta branca:
    // a sondagem continua sendo uma requisicao por fonte.
    return null;
  }
}

async function sondar(code: string, nome: string, url: string): Promise<Resultado> {
  const agente = process.env['INGESTION_USER_AGENT'] ?? 'MeuAssessor/0.1';
  const inicio = Date.now();

  const proibido = await robotsProibe(url, agente);
  if (proibido !== null) {
    return {
      code,
      nome,
      url,
      desfecho: 'robots_proibe',
      detalhe: `robots.txt proibe "${proibido}" para este agente; nao foi requisitado`,
      status: null,
      tipo: null,
      bytes: null,
      ms: Date.now() - inicio,
    };
  }

  try {
    // Uma requisicao por fonte, sem retentativa: a prova e de alcance, e
    // insistir em portal publico de orgao nao e educado nem informativo.
    const r = await fetchGuarded(url, { timeoutMs: 25_000, maxRetries: 1, maxBytes: 4 * 1024 * 1024 });
    return {
      code,
      nome,
      url: r.finalUrl,
      desfecho: 'alcancado',
      detalhe: `respondeu ${r.status}`,
      status: r.status,
      tipo: r.contentType,
      bytes: r.body.byteLength,
      ms: Date.now() - inicio,
    };
  } catch (erro) {
    const ms = Date.now() - inicio;
    if (erro instanceof ConnectorError) {
      const porTipo: Record<string, Desfecho> = {
        auth_failed: 'rejeitado',
        host_not_allowed: 'erro_de_rede',
        blocked_address: 'erro_de_rede',
        timeout: 'indisponivel',
        rate_limited: 'indisponivel',
        http_error: 'nao_encontrado',
        network_error: 'erro_de_rede',
        too_large: 'alcancado',
        schema_changed: 'alcancado',
      };
      return {
        code,
        nome,
        url,
        desfecho: porTipo[erro.kind] ?? 'erro_de_rede',
        detalhe: `${erro.kind}: ${erro.message}`,
        status: null,
        tipo: null,
        bytes: null,
        ms,
      };
    }
    return {
      code,
      nome,
      url,
      desfecho: 'erro_de_rede',
      detalhe: (erro as Error).message,
      status: null,
      tipo: null,
      bytes: null,
      ms,
    };
  }
}

const SIMBOLO: Record<Desfecho, string> = {
  alcancado: 'alcancado',
  rejeitado: 'rejeitado pelo portal',
  nao_encontrado: 'endereco nao encontrado',
  robots_proibe: 'nao sondado (robots.txt)',
  indisponivel: 'indisponivel no momento',
  erro_de_rede: 'erro de rede',
};

/**
 * `atribuivel` decide se o desfecho de cada linha pode ser creditado a fonte.
 *
 * Existe por causa de um erro observado: rodando atras de um proxy de egresso
 * que nega CONNECT, todas as fontes voltaram "rejeitado pelo portal" — e
 * nenhum portal tinha sido contatado. A conclusao geral ja estava protegida
 * pelos controles, mas linha a linha a tabela afirmava algo falso sobre nove
 * orgaos, e e a tabela que alguem copia para um relatorio.
 *
 * Quando os controles falham, o desfecho por fonte deixa de ser afirmado. O
 * detalhe tecnico permanece, porque e o que permite diagnosticar o ambiente.
 */
function tabela(linhas: readonly Resultado[], atribuivel: boolean): string {
  const cabecalho =
    '| Fonte | Endereco sondado | Desfecho | Detalhe | Tempo |\n|---|---|---|---|---|';
  const corpo = linhas
    .map((r) => {
      const desfecho = atribuivel
        ? SIMBOLO[r.desfecho]
        : 'nao atribuivel a fonte (sem saida de rede)';
      return `| ${r.code} — ${r.nome} | \`${r.url}\` | ${desfecho} | ${r.detalhe} | ${r.ms} ms |`;
    })
    .join('\n');
  return `${cabecalho}\n${corpo}`;
}

async function main(): Promise<void> {
  // A allowlist do guard vem do proprio catalogo: a lista autorizada e ele, e
  // digitar os dominios a mao de novo e onde um host errado entraria.
  const dominios = SOURCE_CATALOG.map((s) => s.domain);
  const controles = CONTROLES.map((c) => new URL(c).hostname);
  process.env['INGESTION_ALLOWED_HOSTS'] = [...dominios, ...controles].join(',');
  process.env['INGESTION_USER_AGENT'] ??=
    'MeuAssessor/0.1 (prova de acesso E1; +https://github.com/cardapio-ditado/meu-assessor)';

  const quandoISO = new Date().toISOString();

  const resultadosControle: Resultado[] = [];
  for (const url of CONTROLES) {
    resultadosControle.push(await sondar('CTRL', 'controle neutro', url));
  }
  const saidaDeRede = resultadosControle.some((r) => r.desfecho === 'alcancado');

  const resultados: Resultado[] = [];
  for (const fonte of SOURCE_CATALOG) {
    resultados.push(await sondar(fonte.code, fonte.officialName, fonte.probeUrl ?? fonte.url));
    // Intervalo curto entre fontes: sao orgaos publicos, nao um alvo de carga.
    await new Promise((r) => setTimeout(r, 1_500));
  }

  const indiceJson = process.argv.indexOf('--json');
  if (indiceJson !== -1) {
    const destino = process.argv[indiceJson + 1];
    if (destino === undefined) {
      process.stderr.write('--json exige o caminho do arquivo de destino\n');
      process.exit(2);
    }
    writeFileSync(
      destino,
      `${JSON.stringify(
        {
          quandoISO,
          saidaDeRede,
          desfechoAtribuivelAFonte: saidaDeRede,
          controles: resultadosControle,
          fontes: resultados,
        },
        null,
        2,
      )}\n`,
    );
  }

  const alcancadas = resultados.filter((r) => r.desfecho === 'alcancado').length;
  const partes: string[] = [];
  partes.push(`# Prova de acesso as fontes (etapa E1)\n`);
  partes.push(`Executada em ${quandoISO}.\n`);

  if (!saidaDeRede) {
    partes.push(
      `> **Sondagem inconclusiva.** Os controles neutros (${CONTROLES.join(', ')}) tambem\n` +
        `> falharam, entao o que foi medido e a saida de rede de onde isto rodou, nao os\n` +
        `> portais. Nenhuma conclusao sobre as fontes pode ser tirada desta execucao.\n`,
    );
  } else {
    partes.push(
      `Controles neutros responderam, entao a saida de rede funciona e os desfechos\n` +
        `abaixo descrevem as fontes. **${alcancadas} de ${resultados.length}** alcancadas.\n`,
    );
  }

  partes.push(`\n## Fontes\n\n${tabela(resultados, saidaDeRede)}\n`);
  partes.push(`\n## Controles\n\n${tabela(resultadosControle, true)}\n`);
  partes.push(
    `\n## O que esta prova nao estabelece\n\n` +
      `Alcancar o endereco nao e conector verificado (C.2). Continuam por fazer, por fonte\n` +
      `alcancada: recorte historico efetivamente disponivel (8.4), cobertura de campos,\n` +
      `reproducao de uma amostra e o checklist F.1 antes de habilitar. Nenhuma fonte foi\n` +
      `habilitada por este script, e nenhuma foi marcada como conector verificado.\n`,
  );

  const texto = partes.join('');
  process.stdout.write(`${texto}\n`);

  const resumo = process.env['GITHUB_STEP_SUMMARY'];
  if (resumo !== undefined && resumo !== '') appendFileSync(resumo, texto);

  if (!saidaDeRede) process.exit(1);
}

await main();
