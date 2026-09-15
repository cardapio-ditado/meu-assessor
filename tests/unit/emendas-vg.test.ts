import assert from 'node:assert/strict';
import test from 'node:test';
import {
  linksDeEmendas,
  paginasDeEmendas,
  parseEmendaVg,
  totalDeEmendas,
} from '../../packages/connectors/src/emendas-vg.ts';

test('descobre links, paginas e total da listagem', () => {
  const html = `63 resultado(s)
    <a href="http://emendas.varzeagrande.mt.gov.br/portal/emendas/17">detalhe</a>
    <a href="/portal/emendas/18">detalhe</a>
    <a href="?page=2">2</a><a href="?page=3">3</a>`;
  assert.equal(totalDeEmendas(html), 63);
  assert.equal(paginasDeEmendas(html), 3);
  assert.deepEqual(linksDeEmendas(html).map((url) => url.split('/').at(-1)), ['17', '18']);
});

test('extrai campos e separa os tres estagios financeiros', () => {
  const html = `
    <span class="font-mono">60060004 /2025</span>
    <span>Exercício 2025</span><span>Concluída</span><span>Federal</span>
    <h1>INCREMENTO MAC</h1>
    <p>Valor Orçado</p><p>R$ 11.000.000,00</p>
    <p>Valor Empenhado</p><p>R$ 1.850.435,00</p>
    <p>Valor Pago</p><p>R$ 1.850.435,00</p>
    <dt>Tipo da Emenda</dt><dd>De Comissão</dd>
    <dt>Esfera</dt><dd>Federal</dd>
    <dt>Forma de Repasse</dt><dd>Fundo a Fundo</dd>
    <dt>Parlamentar</dt><dd>COMISSÃO DE ASSUNTOS SOCIAIS - CAS</dd>
    <dt>Partido</dt><dd>-</dd>
    <dt>Órgão Executor</dt><dd>Secretaria da Saúde</dd>
    Última atualização: 10/09/2026 19:25
    <a href="https://emendas.varzeagrande.mt.gov.br/storage/arquivos_emendas/17/plano.pdf">Baixar</a>`;
  const amendment = parseEmendaVg(html, 'https://emendas.varzeagrande.mt.gov.br/portal/emendas/17');
  assert.equal(amendment.codigo, '60060004 /2025');
  assert.equal(amendment.exercicio, 2025);
  assert.equal(amendment.valorOrcado, '11000000.00');
  assert.equal(amendment.valorEmpenhado, '1850435.00');
  assert.equal(amendment.valorPago, '1850435.00');
  assert.equal(amendment.atualizadoEm, '2026-09-10');
  assert.equal(amendment.partido, null);
  assert.equal(amendment.documentos.length, 1);
});
