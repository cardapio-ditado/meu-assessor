import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeminiDocumentSynthesis,
  parseGeminiInterpretation,
} from '../../packages/ai/src/gemini.ts';

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

  test('vincula a sintese somente aos documentos recuperados', () => {
    const documents = [{
      documentIndex: 1,
      sourceCode: 'F04',
      title: 'Diario Oficial 539',
      publicationDate: '2026-07-10',
      snippet: 'O ato designa fiscais para acompanhar contratos.',
    }];
    const result = parseGeminiDocumentSynthesis(
      JSON.stringify({
        summary: 'Foram localizadas designacoes de fiscais de contratos.',
        items: [{
          documentIndex: 1,
          headline: 'Fiscalizacao de contratos',
          explanation: 'O ato designa servidores para acompanhar a execucao contratual.',
          attention: 'Verificar se todas as designacoes continuam vigentes.',
        }, {
          documentIndex: 99,
          headline: 'Documento inventado',
          explanation: 'Nao pode entrar.',
          attention: '',
        }],
        limitations: ['O trecho nao apresenta valores contratuais.'],
      }),
      documents,
      'gemini-3.5-flash-lite',
    );

    assert.equal(result.provider, 'gemini');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.documentIndex, 1);
    assert.equal(result.items[0]?.headline, 'Fiscalizacao de contratos');
    assert.deepEqual(result.limitations, ['O trecho nao apresenta valores contratuais.']);
  });

});
