import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiInterpretation } from '../../packages/ai/src/gemini.ts';

describe('interpretacao segura do Gemini', () => {
  test('aceita somente consulta curta e palavras textuais', () => {
    const result = parseGeminiInterpretation(
      JSON.stringify({
        searchQuery: '  contratos de saúde 2026  ',
        keywords: ['contratos', 42, 'saúde', '', '2026'],
      }),
      'quais contratos temos?',
      'gemini-3.5-flash-lite',
    );
    assert.equal(result.searchQuery, 'contratos de saúde 2026');
    assert.deepEqual(result.keywords, ['contratos', 'saúde', '2026']);
    assert.equal(result.provider, 'gemini');
  });

  test('nao permite que a consulta expandida cresca sem limite', () => {
    const result = parseGeminiInterpretation(
      JSON.stringify({ searchQuery: 'x'.repeat(600), keywords: [] }),
      'contratos',
      'gemini-3.5-flash-lite',
    );
    assert.equal(result.searchQuery.length, 300);
  });

  test('consulta vazia volta para a pergunta original', () => {
    const result = parseGeminiInterpretation(
      JSON.stringify({ searchQuery: ' ', keywords: [] }),
      'emendas destinadas',
      'gemini-3.5-flash-lite',
    );
    assert.equal(result.searchQuery, 'emendas destinadas');
  });
});
