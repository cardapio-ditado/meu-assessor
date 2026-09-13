/**
 * Conector do PNCP, parte pura.
 *
 * A amostra em `fixtures/pncp/` e uma resposta REAL do orgao do piloto,
 * capturada em 2026-09-13. Testar contra ela e o que separa "o parser compila"
 * de "o parser le o que a fonte manda": os nomes de campo aqui nao foram
 * escolhidos por mim, foram observados (8.3).
 *
 * A conversao de dinheiro em si e testada em `dinheiro.test.ts`: ela deixou de
 * ser do PNCP quando o segundo conector passou a usar a mesma funcao.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectorError } from '../../packages/connectors/src/http.ts';
import {
  digitosCnpj,
  parsePaginaContratos,
  textoDoContrato,
  tituloDoContrato,
  urlContratos,
} from '../../packages/connectors/src/pncp.ts';

const amostra: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/pncp/contratos-varzea-grande.json', import.meta.url), 'utf8'),
);

describe('endereco da consulta', () => {
  test('usa yyyyMMdd e CNPJ so com digitos, que e o que a API aceita', () => {
    const url = urlContratos({
      cnpjOrgao: '03.507.548/0001-10',
      janela: { de: '2026-01-01', ate: '2026-06-30' },
      pagina: 1,
    });
    assert.match(url, /dataInicial=20260101/);
    assert.match(url, /dataFinal=20260630/);
    assert.match(url, /cnpjOrgao=03507548000110/);
    assert.match(url, /pagina=1/);
    // O provedor recusou tamanho 2 com "Tamanho de pagina invalido".
    assert.match(url, /tamanhoPagina=50/);
  });

  test('data fora do formato para a coleta em vez de montar endereco torto', () => {
    assert.throws(
      () => urlContratos({ cnpjOrgao: '03507548000110', janela: { de: '01/01/2026', ate: '2026-06-30' }, pagina: 1 }),
      ConnectorError,
    );
  });

  test('digitosCnpj remove pontuacao', () => {
    assert.equal(digitosCnpj('03.507.548/0001-10'), '03507548000110');
  });
});

describe('leitura da amostra real', () => {
  const pagina = parsePaginaContratos(amostra);
  const c = pagina.contratos[0];

  test('a paginacao vem da resposta, nao de suposicao', () => {
    assert.equal(pagina.totalRegistros, 28);
    assert.equal(pagina.totalPaginas, 3);
    assert.equal(pagina.paginaAtual, 1);
    assert.equal(pagina.paginasRestantes, 2);
  });

  test('campos que o produto usa saem corretos', () => {
    assert.ok(c !== undefined);
    assert.equal(c.numeroControlePNCP, '03507548000110-2-000017/2025');
    assert.equal(c.numeroContrato, '75');
    assert.equal(c.anoContrato, 2025);
    assert.equal(c.orgaoCnpj, '03507548000110');
    assert.equal(c.fornecedorNome, 'ECO-HABITAT CONSULTORIA SOCIAL LTDA');
    assert.equal(c.fornecedorNi, '41245254000157');
    assert.equal(c.unidadeNome, 'SECRETARIA MUNICIPAL DE VIACAO E OBRAS');
    assert.equal(c.codigoIbge, '5108402');
    assert.equal(c.processo, '178/2024');
    assert.equal(c.valorGlobalCentavos, 67395000n);
    assert.equal(c.numeroParcelas, 12);
    assert.equal(c.ressalvaValor, null);
  });

  test('as datas ficam em papeis SEPARADOS (12.2)', () => {
    assert.ok(c !== undefined);
    // Assinatura em julho de 2025; publicacao no PNCP so em fevereiro de 2026.
    // Confundir as duas faz o contrato aparecer no periodo errado.
    assert.equal(c.dataAssinatura, '2025-07-28');
    assert.equal(c.dataPublicacao, '2026-02-13');
    assert.equal(c.vigenciaInicio, '2025-07-28');
    assert.equal(c.vigenciaFim, '2026-07-28');
    assert.notEqual(c.dataAssinatura, c.dataPublicacao);
  });

  test('o texto guardado contem aquilo por que alguem procura', () => {
    assert.ok(c !== undefined);
    const texto = textoDoContrato(c);
    for (const esperado of [
      'ECO-HABITAT',
      'VIACAO E OBRAS',
      '178/2024',
      'TRABALHO SOCIAL',
      '03507548000110-2-000017/2025',
    ]) {
      assert.ok(texto.includes(esperado), `o texto precisa citar ${esperado}`);
    }
  });

  test('o titulo cabe num cartao sem cortar o numero do contrato', () => {
    assert.ok(c !== undefined);
    const titulo = tituloDoContrato(c);
    assert.ok(titulo.startsWith('Contrato 75/2025'));
    assert.ok(titulo.length <= 140);
  });
});

describe('mudanca de contrato da fonte para a coleta (13.4)', () => {
  test('resposta sem a lista `data` e erro, nao lote vazio', () => {
    // Um lote vazio pareceria sucesso e sumiria no relatorio.
    assert.throws(() => parsePaginaContratos({ totalRegistros: 0 }), ConnectorError);
  });

  test('registro sem identificador estavel para a coleta', () => {
    // Sem numeroControlePNCP a deduplicacao (13.3) nao tem chave, e repetir o
    // lote criaria contratos duplicados.
    assert.throws(
      () => parsePaginaContratos({ data: [{ orgaoEntidade: { cnpj: '1', razaoSocial: 'X' } }] }),
      ConnectorError,
    );
  });

  test('registro sem orgao para a coleta', () => {
    assert.throws(
      () => parsePaginaContratos({ data: [{ numeroControlePNCP: 'x' }] }),
      ConnectorError,
    );
  });

  test('valor com decimo de centavo vira ressalva, nao valor arredondado', () => {
    const pagina = parsePaginaContratos({
      data: [
        {
          numeroControlePNCP: 'x-1/2026',
          orgaoEntidade: { cnpj: '03507548000110', razaoSocial: 'MUNICIPIO DE VARZEA GRANDE' },
          valorGlobal: 10.005,
        },
      ],
    });
    const c = pagina.contratos[0];
    assert.ok(c !== undefined);
    assert.equal(c.valorGlobalCentavos, null);
    assert.match(c.ressalvaValor ?? '', /nao cabe em centavos/);
  });
});
