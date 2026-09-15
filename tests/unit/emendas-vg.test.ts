import assert from 'node:assert/strict';
import test from 'node:test';
import {
  linksDeEmendas,
  paginasDeEmendas,
  parseListaEmendasVg,
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

test('extrai emendas diretamente da tabela pública', () => {
  const html = `<table><tbody><tr>
    <td>2026</td><td>025/2026</td><td><span>Estadual</span></td>
    <td>Transferência Especial</td><td><p>Paulo Araújo</p><p>Republicanos</p></td>
    <td>Repasse financeiro para Custeio na Saúde</td><td>Secretaria da Saúde</td>
    <td>R$ 250.000,00</td><td>R$ 500.000,00</td><td><span>Concluída</span></td>
    <td><a href="https://emendas.varzeagrande.mt.gov.br/portal/emendas/31">Ver detalhes</a></td>
  </tr></tbody></table>`;
  const [amendment] = parseListaEmendasVg(html);
  assert.equal(amendment?.id, '31');
  assert.equal(amendment?.parlamentar, 'Paulo Araújo');
  assert.equal(amendment?.valorOrcado, '250000.00');
  assert.equal(amendment?.valorPago, '500000.00');
  assert.equal(amendment?.valorEmpenhado, null);
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
