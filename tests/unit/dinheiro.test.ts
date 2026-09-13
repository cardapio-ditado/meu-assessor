/**
 * Conversao de dinheiro para centavos exatos (10.4).
 *
 * Estes casos moravam no teste do PNCP. Saíram de la quando o segundo conector
 * passou a usar a mesma conversao: uma regra de dinheiro testada dentro de um
 * conector so vale para aquele conector, e a pergunta "quanto custou" precisa
 * ter uma resposta so no produto inteiro.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { centavosExatos } from '../../packages/connectors/src/dinheiro.ts';

describe('valores em centavos exatos (10.4)', () => {
  test('valor com uma casa converte sem perda', () => {
    assert.equal(centavosExatos(673950.0), 67395000n);
  });

  test('duas casas decimais convertem', () => {
    assert.equal(centavosExatos(1234.56), 123456n);
  });

  test('decimo de centavo NAO e arredondado em silencio', () => {
    // Arredondar trocaria o valor do registro por outro parecido, e ninguem
    // perceberia lendo a tela. Devolver null obriga a registrar a ressalva.
    assert.equal(centavosExatos(10.005), null);
  });

  test('ausente e nulo, nao zero', () => {
    assert.equal(centavosExatos(null), null);
    assert.equal(centavosExatos(undefined), null);
    assert.equal(centavosExatos('673950'), null);
  });

  test('zero declarado pela fonte E um valor, nao ausencia', () => {
    // O inverso do caso acima, e igualmente importante: o Transferegov declara
    // `valor_custeio: 0.0` quando a emenda e toda de investimento. Devolver
    // null aqui apagaria uma informacao que a fonte deu.
    assert.equal(centavosExatos(0), 0n);
    assert.equal(centavosExatos(0.0), 0n);
  });
});
