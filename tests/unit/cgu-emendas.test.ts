import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorError } from '../../packages/connectors/src/http.ts';
import {
  dataCgu,
  dinheiroCgu,
  parseDocumentosEmendaCgu,
  parseEmendasCgu,
  textoDocumentoEmendaCgu,
  textoEmendaCgu,
  urlDocumentosEmendaCgu,
  urlEmendasCgu,
} from '../../packages/connectors/src/cgu-emendas.ts';

const amostraEmenda = {
  codigoEmenda: '202440340007',
  ano: 2024,
  tipoEmenda: 'Emenda Individual - Transferências com Finalidade Definida',
  autor: 'LUISA CANZIANI',
  nomeAutor: 'LUISA CANZIANI',
  numeroEmenda: '0007',
  localidadeDoGasto: 'LONDRINA - PR',
  funcao: 'Saúde',
  subfuncao: 'Assistência hospitalar e ambulatorial',
  valorEmpenhado: '10.000,00',
  valorLiquidado: '10.000,00',
  valorPago: '10.000,00',
  valorRestoInscrito: '0,00',
  valorRestoCancelado: '0,00',
  valorRestoPago: '0,00',
};

const amostraDocumento = {
  id: 1310703641,
  data: '26/06/2024',
  fase: 'Empenho',
  codigoDocumento: '170860000012024NE003139',
  codigoDocumentoResumido: '2024NE003139',
  especieTipo: 'Não se aplica',
  tipoEmenda: 'Emenda Individual - Transferências Especiais',
};

describe('enderecos oficiais da CGU', () => {
  test('consulta emenda por codigo exato e pagina documentada', () => {
    const url = new URL(urlEmendasCgu('202440340007'));
    assert.equal(url.pathname, '/api-de-dados/emendas');
    assert.equal(url.searchParams.get('codigoEmenda'), '202440340007');
    assert.equal(url.searchParams.get('pagina'), '1');
  });

  test('consulta documentos com codigo no caminho e pagina', () => {
    const url = new URL(urlDocumentosEmendaCgu('202440340007', 2));
    assert.equal(url.pathname, '/api-de-dados/emendas/documentos/202440340007');
    assert.equal(url.searchParams.get('pagina'), '2');
  });

  test('recusa codigo que nao tem o formato oficial observado', () => {
    assert.throws(() => urlEmendasCgu('4200008/2025'), ConnectorError);
  });
});

describe('parser da CGU', () => {
  test('preserva centavos e zero sem usar ponto flutuante', () => {
    assert.equal(dinheiroCgu('1.234.567,89'), '1234567.89');
    assert.equal(dinheiroCgu('0,00'), '0.00');
    assert.equal(dinheiroCgu(null), null);
  });

  test('converte a data brasileira do documento', () => {
    assert.equal(dataCgu('26/06/2024'), '2024-06-26');
  });

  test('le a emenda observada e todos os estagios', () => {
    const e = parseEmendasCgu([amostraEmenda])[0];
    assert.ok(e !== undefined);
    assert.equal(e.codigo, '202440340007');
    assert.equal(e.autor, 'LUISA CANZIANI');
    assert.equal(e.valorEmpenhado, '10000.00');
    assert.equal(e.valorLiquidado, '10000.00');
    assert.equal(e.valorPago, '10000.00');
    assert.equal(e.valorRestoInscrito, '0.00');
  });

  test('le documento observado com identificador estavel', () => {
    const d = parseDocumentosEmendaCgu([amostraDocumento])[0];
    assert.ok(d !== undefined);
    assert.equal(d.id, '1310703641');
    assert.equal(d.data, '2024-06-26');
    assert.equal(d.fase, 'Empenho');
    assert.equal(d.codigoResumido, '2024NE003139');
  });

  test('mudanca de lista para envelope falha visivelmente', () => {
    assert.throws(() => parseEmendasCgu({ data: [amostraEmenda] }), ConnectorError);
    assert.throws(() => parseDocumentosEmendaCgu({ data: [amostraDocumento] }), ConnectorError);
  });
});

describe('texto para o gestor', () => {
  test('explica estagios em vez de guardar JSON cru', () => {
    const e = parseEmendasCgu([amostraEmenda])[0];
    assert.ok(e !== undefined);
    const texto = textoEmendaCgu(e, 15);
    assert.match(texto, /valor reservado formalmente/);
    assert.match(texto, /despesa reconhecida/);
    assert.match(texto, /pagamento registrado pela União/);
    assert.match(texto, /não devem ser somados/);
  });

  test('documento explica limite da propria evidencia', () => {
    const d = parseDocumentosEmendaCgu([amostraDocumento])[0];
    assert.ok(d !== undefined);
    const texto = textoDocumentoEmendaCgu('202440340007', d);
    assert.match(texto, /Fase da despesa: Empenho/);
    assert.match(texto, /o valor deve ser lido da consulta financeira/);
  });
});
