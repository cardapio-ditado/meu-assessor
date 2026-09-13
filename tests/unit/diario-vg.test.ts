/**
 * Conector do Diario Oficial de Varzea Grande, parte pura (fonte F04).
 *
 * As amostras em `fixtures/diario-vg/` sao recortes VERBATIM do portal,
 * capturados em 2026-09-13. A marcacao aqui nao foi escrita por mim, foi
 * observada (8.3) — incluindo a peculiaridade que mais importa: duas edicoes
 * com o MESMO numero no mesmo dia.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectorError } from '../../packages/connectors/src/http.ts';
import {
  idExterno,
  paginaDoTrecho,
  parseListagem,
  textoDaEdicao,
  tituloDaEdicao,
  urlDoPdf,
  urlListagem,
} from '../../packages/connectors/src/diario-vg.ts';

const listagem = readFileSync(new URL('../../fixtures/diario-vg/edicoes-recorte.html', import.meta.url), 'utf8');
const paginaEdicao = readFileSync(new URL('../../fixtures/diario-vg/edicao-189.html', import.meta.url), 'utf8');

describe('leitura da listagem real', () => {
  const edicoes = parseListagem(listagem);

  test('encontra as cinco edicoes do recorte', () => {
    assert.equal(edicoes.length, 5);
    assert.equal(urlListagem(), 'https://diariooficial.varzeagrande.mt.gov.br/edicoes');
  });

  test('campos saem corretos, com data em ISO', () => {
    const primeira = edicoes[0];
    assert.ok(primeira !== undefined);
    assert.equal(primeira.id, '189');
    assert.equal(primeira.numero, '539');
    assert.equal(primeira.data, '2026-07-10');
    assert.equal(primeira.tipo, 'Normal');
    assert.equal(primeira.titulo, 'Diário Oficial Eletrônico do Município 539');
    assert.equal(primeira.urlEdicao, 'https://diariooficial.varzeagrande.mt.gov.br/edicao/189');
  });

  test('o NUMERO da edicao nao e chave unica; o id do portal e', () => {
    // Este e o teste que impede o bug caro: a edicao 538 sai duas vezes no
    // mesmo dia, "Normal" e "Suplemento". Deduplicar por numero fundiria as
    // duas e uma delas sumiria sem ninguem notar (13.3).
    const quinhentosETrintaEOito = edicoes.filter((e) => e.numero === '538');
    assert.equal(quinhentosETrintaEOito.length, 2);
    assert.deepEqual(
      quinhentosETrintaEOito.map((e) => e.tipo).sort(),
      ['Normal', 'Suplemento'],
    );
    const ids = new Set(edicoes.map(idExterno));
    assert.equal(ids.size, edicoes.length, 'o identificador externo precisa ser unico por edicao');
  });

  test('o titulo distingue o suplemento da edicao normal do mesmo dia', () => {
    const suplemento = edicoes.find((e) => e.tipo === 'Suplemento');
    const normal = edicoes.find((e) => e.numero === '538' && e.tipo === 'Normal');
    assert.ok(suplemento !== undefined && normal !== undefined);
    assert.match(tituloDaEdicao(suplemento), /Suplemento/);
    assert.notEqual(tituloDaEdicao(suplemento), tituloDaEdicao(normal));
    assert.match(tituloDaEdicao(normal), /09\/07\/2026/);
  });

  test('as edicoes vem em ordem decrescente de data no recorte', () => {
    const datas = edicoes.map((e) => e.data);
    assert.deepEqual(datas, [...datas].sort().reverse());
  });
});

describe('endereco do PDF', () => {
  test('e LIDO da pagina, e o nome do arquivo nao segue a data', () => {
    // "013_edicao_539_DOM.pdf" esta em 07-Julho e a edicao e de 10/07/2026: o
    // 013 e o decimo terceiro arquivo do mes. Qualquer padrao deduzido da data
    // baixaria o diario de outro dia.
    const url = urlDoPdf(paginaEdicao);
    assert.equal(
      url,
      'https://diariooficial.varzeagrande.mt.gov.br/storage/diarios/2026/07-Julho/013_edicao_539_DOM.pdf',
    );
    assert.ok(!url.includes('/10_'), 'o nome do arquivo nao carrega o dia da edicao');
  });

  test('pagina sem PDF para a coleta', () => {
    assert.throws(() => urlDoPdf('<div>sem anexo</div>'), ConnectorError);
  });

  test('pagina com dois PDFs para a coleta em vez de escolher um', () => {
    // Escolher seria adivinhar qual arquivo e a edicao.
    assert.throws(
      () => urlDoPdf('<a href="/a/um.pdf">x</a><a href="/b/dois.pdf">y</a>'),
      ConnectorError,
    );
  });
});

describe('texto guardado da edicao', () => {
  const edicoes = parseListagem(listagem);
  const e = edicoes[0];
  const paginas = [
    { numero: 1, texto: 'ÍNDICE\nPREFEITURA MUNICIPAL DE VÁRZEA GRANDE' },
    { numero: 2, texto: 'PORTARIA N. 123/2026\nCONTROLADORIA GERAL DO MUNICÍPIO' },
  ];

  test('carrega os campos por que alguem procura', () => {
    assert.ok(e !== undefined);
    const texto = textoDaEdicao(e, paginas);
    for (const esperado of ['539', '2026-07-10', 'PORTARIA N. 123/2026', 'CONTROLADORIA']) {
      assert.ok(texto.includes(esperado), `o texto precisa citar ${esperado}`);
    }
  });

  test('marca as paginas, para a evidencia poder apontar onde', () => {
    // Sem a marca, a evidencia de um diario de 24 paginas seria "esta em algum
    // lugar do documento", que nao e ancoragem (12.1).
    assert.ok(e !== undefined);
    const texto = textoDaEdicao(e, paginas);
    assert.match(texto, /\[pagina 1\]/);
    assert.match(texto, /\[pagina 2\]/);
  });

  test('paginaDoTrecho acha a pagina certa e admite quando nao acha', () => {
    assert.equal(paginaDoTrecho(paginas, 'PORTARIA N. 123/2026'), 2);
    assert.equal(paginaDoTrecho(paginas, 'ÍNDICE'), 1);
    // Afirmar uma pagina errada e pior que nao afirmar nenhuma.
    assert.equal(paginaDoTrecho(paginas, 'texto que nao esta no diario'), null);
    assert.equal(paginaDoTrecho(paginas, '   '), null);
  });
});

describe('mudanca de marcacao para a coleta (13.4)', () => {
  test('listagem vazia e erro, nao zero edicoes', () => {
    // Zero edicoes pareceria "o diario nao publicou nada", que e uma afirmacao
    // sobre o municipio, nao sobre o parser.
    assert.throws(() => parseListagem('<html><body>nada aqui</body></html>'), ConnectorError);
  });

  test('linha com link mas sem numero para a leitura', () => {
    assert.throws(
      () => parseListagem('<tr><td>x</td><td><a href="/edicao/9">abrir</a></td></tr>'),
      ConnectorError,
    );
  });

  test('data fora do formato do portal para a leitura', () => {
    assert.throws(
      () =>
        parseListagem(
          '<tr><td class="numero">1</td><td>2026-07-10</td><td>Normal</td><td>t</td>' +
            '<td><a href="/edicao/9">abrir</a></td></tr>',
        ),
      ConnectorError,
    );
  });
});
