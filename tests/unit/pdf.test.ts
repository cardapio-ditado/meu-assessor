/**
 * Extracao de texto de PDF.
 *
 * O caso que existe aqui nao foi imaginado: veio da primeira coleta real do
 * Diario Oficial, em que o texto gravado no banco dizia "Diario O昀椀cial".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repararLigaduras } from '../../packages/connectors/src/pdf.ts';

describe('ligaduras corrompidas pelo proprio PDF', () => {
  test('conserta fi, fl e ff em texto real do diario', () => {
    // Trecho REAL da pagina 2 da edicao 539, como saiu na primeira coleta.
    assert.equal(
      repararLigaduras('Diário O昀椀cial Eletrônico da Prefeitura Municipal de Várzea Grande'),
      'Diário Oficial Eletrônico da Prefeitura Municipal de Várzea Grande',
    );
    assert.equal(repararLigaduras('por meio do sistema GESPRO, utilizando o 昀氀uxo'), 'por meio do sistema GESPRO, utilizando o fluxo');
  });

  test('o defeito quebraria a busca, que e o motivo de consertar', () => {
    // Quem procura "Oficial" nao acha "O昀椀cial": a tela fica vazia sem
    // explicacao, e ninguem investiga uma coleta bem-sucedida.
    const corrompido = 'Diário O昀椀cial';
    assert.ok(!corrompido.includes('Oficial'));
    assert.ok(repararLigaduras(corrompido).includes('Oficial'));
  });

  test('nao encosta em simbolo legitimo com byte baixo zero', () => {
    // ∀ (U+2200) e ✀ (U+2700) tambem tem byte baixo zero. Consertar demais
    // seria trocar um texto errado por outro.
    assert.equal(repararLigaduras('∀x ✀ ─ ☀'), '∀x ✀ ─ ☀');
  });

  test('nao mexe em acento, cedilha nem texto comum', () => {
    const normal = 'PORTARIA N. 123/2026 — nomeação de servidor, R$ 1.234,56; ç ã é ü';
    assert.equal(repararLigaduras(normal), normal);
  });

  test('texto vazio continua vazio', () => {
    assert.equal(repararLigaduras(''), '');
  });
});
