/**
 * Conector do Transferegov, parte pura (fonte F10).
 *
 * A amostra em `fixtures/transferegov/` e uma resposta REAL da API para o
 * municipio do piloto, capturada em 2026-09-13. Testar contra ela e o que
 * separa "o parser compila" de "o parser le o que a fonte manda": os nomes de
 * campo aqui nao foram escolhidos por mim, foram observados (8.3).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectorError } from '../../packages/connectors/src/http.ts';
import {
  digitosCnpj,
  objetoDoPlano,
  parsePaginaBeneficiarios,
  parsePaginaPlanosAcao,
  textoDoPlano,
  tituloDoPlano,
  urlBeneficiarios,
  urlPlanosAcao,
} from '../../packages/connectors/src/transferegov.ts';

const amostra: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/transferegov/planos-acao-varzea-grande.json', import.meta.url), 'utf8'),
);

describe('endereco da consulta', () => {
  test('o filtro de CNPJ leva o valor CRU, sem sintaxe de operador', () => {
    // A primeira tentativa usou `cnpj_beneficiario=eq.0350...`, sintaxe de
    // PostgREST. A API respondeu 200 com lista vazia: o filtro foi aplicado
    // sobre um literal que nao existe. Uma lista vazia nao parece erro, e esse
    // e o ponto — o teste existe para que a sintaxe errada nao volte.
    const url = urlBeneficiarios('03.507.548/0001-10');
    assert.match(url, /cnpj_beneficiario=03507548000110/);
    assert.ok(!url.includes('eq.'), 'o valor nao pode vir prefixado por operador');
  });

  test('CNPJ truncado para a consulta em vez de trazer outro beneficiario', () => {
    assert.throws(() => urlBeneficiarios('03507548'), ConnectorError);
  });

  test('digitosCnpj remove pontuacao', () => {
    assert.equal(digitosCnpj('03.507.548/0001-10'), '03507548000110');
  });

  test('plano de acao e consultado por id_beneficiario, nao por nome', () => {
    // 10.3: vinculo por identificador oficial. O nome do municipio nem sequer
    // e parametro deste endpoint.
    const url = urlPlanosAcao({ idBeneficiario: 3773, pagina: 1 });
    assert.match(url, /id_beneficiario=3773/);
    assert.match(url, /pagina=1/);
    assert.match(url, /tamanho_da_pagina=50/);
  });
});

describe('leitura do beneficiario', () => {
  const pagina = parsePaginaBeneficiarios({
    data: [
      {
        id_beneficiario: 3773,
        uf_beneficiario: 'MT',
        nome_beneficiario: 'MUNICIPIO DE VARZEA GRANDE',
        cnpj_beneficiario: '03507548000110',
        id_ente: 5256,
      },
    ],
    total_pages: 1,
    total_items: 1,
    page_number: 1,
    page_size: 1,
  });

  test('devolve o identificador que liga o municipio aos planos', () => {
    assert.equal(pagina.totalItens, 1);
    assert.equal(pagina.beneficiarios[0]?.idBeneficiario, 3773);
    assert.equal(pagina.beneficiarios[0]?.cnpj, '03507548000110');
  });

  test('beneficiario sem id para a coleta em vez de virar lista vazia', () => {
    assert.throws(
      () => parsePaginaBeneficiarios({ data: [{ nome_beneficiario: 'X', cnpj_beneficiario: '1' }] }),
      ConnectorError,
    );
  });
});

describe('leitura da amostra real', () => {
  const pagina = parsePaginaPlanosAcao(amostra);
  const p = pagina.planos[0];
  const segundo = pagina.planos[1];

  test('a paginacao vem da resposta, nao de suposicao', () => {
    assert.equal(pagina.totalItens, 14);
    assert.equal(pagina.totalPaginas, 7);
    assert.equal(pagina.paginaAtual, 1);
    assert.equal(pagina.tamanhoPagina, 2);
  });

  test('campos que o produto usa saem corretos', () => {
    assert.ok(p !== undefined);
    assert.equal(p.idPlanoAcao, 3899);
    assert.equal(p.codigoPlanoAcao, '0903-003899');
    assert.equal(p.anoPlanoAcao, 2020);
    assert.equal(p.situacao, 'CIENTE');
    assert.equal(p.modalidade, 'Especial');
    assert.equal(p.dataAceite, '2020-05-21');
    assert.equal(p.idBeneficiario, 3773);
    assert.equal(p.categoriaDespesa, 'INVESTIMENTO');
  });

  test('a emenda carrega o IDENTIFICADOR, nao so o nome do parlamentar', () => {
    // 10.3: o vinculo com a emenda tem de sobreviver a homonimo e a grafia.
    assert.ok(p !== undefined);
    assert.equal(p.numeroEmenda, '202023760004');
    assert.equal(p.codigoParlamentar, 2376);
    assert.equal(p.anoEmenda, 2020);
    assert.equal(p.nomeParlamentar, 'Jayme Campos');
  });

  test('numero de emenda e identificador, entao vira texto e nao perde digito', () => {
    assert.ok(p !== undefined);
    assert.equal(typeof p.numeroEmenda, 'string');
    assert.equal(p.numeroEmenda?.length, 12);
  });

  test('zero declarado e zero; investimento e o valor real', () => {
    assert.ok(p !== undefined);
    assert.equal(p.custeioCentavos, 0n);
    assert.equal(p.investimentoCentavos, 116000000n);
    assert.equal(p.totalCentavos, 116000000n);
    assert.equal(p.ressalvaValor, null);
  });

  test('o segundo registro tem outro valor e outro formato de codigo', () => {
    // Os dois formatos de `codigo_plano_acao` convivem na mesma resposta
    // ("0903-003899" e "09032022-017573"). Um parser que assumisse um formato
    // unico quebraria em producao.
    assert.ok(segundo !== undefined);
    assert.equal(segundo.codigoPlanoAcao, '09032022-017573');
    assert.equal(segundo.investimentoCentavos, 50000000n);
  });

  test('objeto ausente NAO e substituido pela area de politica publica', () => {
    // A area diz o setor; nao diz o que foi feito. Preencher o objeto com ela
    // seria inventar conteudo que a fonte nao deu.
    assert.ok(p !== undefined);
    assert.equal(p.nomeObjeto, null);
    assert.equal(objetoDoPlano(p), null);
  });

  test('o texto guardado contem aquilo por que alguem procura', () => {
    assert.ok(p !== undefined);
    const texto = textoDoPlano(p);
    for (const esperado of ['Jayme Campos', '202023760004', 'Assistência Social', 'CIENTE']) {
      assert.ok(texto.includes(esperado), `o texto precisa citar ${esperado}`);
    }
  });

  test('o texto diz que o valor NAO foi pago (11.1)', () => {
    // Plano de acao aceito e destinacao, nao pagamento. Quem le a tela nao tem
    // como saber disso se o texto nao disser.
    assert.ok(p !== undefined);
    assert.match(textoDoPlano(p), /Nao e valor empenhado, transferido nem pago/);
  });

  test('dado bancario e email nao entram no texto guardado', () => {
    // Minimizacao: o produto nao responde nenhuma pergunta com o numero da
    // conta, e o que nao e guardado nao vaza.
    assert.ok(segundo !== undefined);
    const texto = textoDoPlano(segundo);
    assert.ok(!texto.includes('575862643'), 'numero da conta nao pode ser guardado');
    assert.ok(!texto.includes('@'), 'email de contato nao pode ser guardado');
  });

  test('o titulo cabe num cartao sem cortar o codigo do plano', () => {
    assert.ok(p !== undefined);
    const titulo = tituloDoPlano(p);
    assert.ok(titulo.startsWith('Plano de acao 0903-003899'));
    assert.ok(titulo.length <= 140);
  });
});

describe('mudanca de contrato da fonte para a coleta (13.4)', () => {
  test('resposta sem a lista `data` e erro, nao lote vazio', () => {
    // Um lote vazio pareceria sucesso e sumiria no relatorio.
    assert.throws(() => parsePaginaPlanosAcao({ total_items: 0 }), ConnectorError);
  });

  test('registro sem identificador estavel para a coleta', () => {
    assert.throws(
      () => parsePaginaPlanosAcao({ data: [{ codigo_plano_acao: 'x' }] }),
      ConnectorError,
    );
  });

  test('registro sem codigo para a coleta', () => {
    assert.throws(() => parsePaginaPlanosAcao({ data: [{ id_plano_acao: 1 }] }), ConnectorError);
  });
});

describe('valores que nao cabem viram ressalva, nao numero errado', () => {
  const pagina = parsePaginaPlanosAcao({
    data: [
      {
        id_plano_acao: 1,
        codigo_plano_acao: 'x-1',
        valor_custeio_plano_acao: 10.005,
        valor_investimento_plano_acao: 500000.0,
      },
    ],
  });
  const p = pagina.planos[0];

  test('a parcela impossivel fica nula com motivo', () => {
    assert.ok(p !== undefined);
    assert.equal(p.custeioCentavos, null);
    assert.match(p.ressalvaValor ?? '', /nao cabe em centavos/);
  });

  test('o TOTAL nao e calculado com parcela desconhecida', () => {
    // Somar 0 no lugar do custeio daria um total menor que o real, com cara de
    // numero conferido. Pior que nao ter total.
    assert.ok(p !== undefined);
    assert.equal(p.totalCentavos, null);
  });

  test('parcela ausente na fonte tambem vira ressalva, nao zero', () => {
    const semValor = parsePaginaPlanosAcao({ data: [{ id_plano_acao: 2, codigo_plano_acao: 'y' }] });
    const q = semValor.planos[0];
    assert.ok(q !== undefined);
    assert.equal(q.investimentoCentavos, null);
    assert.equal(q.totalCentavos, null);
    assert.match(q.ressalvaValor ?? '', /ausente na fonte/);
  });
});
