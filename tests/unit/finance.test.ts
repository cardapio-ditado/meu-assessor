/**
 * Regras financeiras. Cobre os casos T08, T11, T12, T13, T14, T15 e o exemplo
 * inteiramente ficticio do briefing 11.5.
 *
 * Todos os numeros aqui sao dados de teste e nao se referem a Varzea Grande
 * nem a qualquer agente publico real.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, parseMoney, money } from '../../packages/domain/src/money.ts';
import { dateRange, plainDate } from '../../packages/domain/src/temporal.ts';
import type { FinancialEvent } from '../../packages/domain/src/types.ts';
import type { FinancialStage } from '../../packages/domain/src/states.ts';
import { attributeCollective, computeTotal, explainTotal } from '../../packages/finance/src/totals.ts';
import { crossSourceKey, deduplicate, sourceKey } from '../../packages/finance/src/dedup.ts';
import { assessChain, type ChainLink } from '../../packages/finance/src/chain.ts';

let counter = 0;

type EventSpec = Omit<Partial<FinancialEvent>, 'amount'> & {
  stage: FinancialStage;
  amount: string;
};

/**
 * `??` NAO cai para o padrao quando o campo e explicitamente null, e varios
 * campos aqui precisam poder ser null de proposito (uma data do fato ausente e
 * um caso de teste, nao um valor faltando). Por isso a presenca da chave manda.
 */
function pick<K extends keyof FinancialEvent>(
  spec: EventSpec,
  key: K,
  fallback: FinancialEvent[K],
): FinancialEvent[K] {
  return key in spec ? (spec[key as keyof EventSpec] as FinancialEvent[K]) : fallback;
}

function event(partial: EventSpec): FinancialEvent {
  counter += 1;
  return {
    id: partial.id ?? `evt-${counter}`,
    tenantId: 't1',
    sourceId: partial.sourceId ?? 'src-a',
    externalId: partial.externalId ?? `ext-${counter}`,
    payerEntityId: partial.payerEntityId ?? null,
    payeeEntityId: pick(partial, 'payeeEntityId', 'fundo-1'),
    instrumentId: pick(partial, 'instrumentId', 'emenda-1'),
    subjectId: pick(partial, 'subjectId', null),
    financialDocument: pick(partial, 'financialDocument', null),
    cancelsEventId: pick(partial, 'cancelsEventId', null),
    stage: partial.stage,
    factDate: pick(partial, 'factDate', plainDate('2026-04-15')),
    budgetYear: pick(partial, 'budgetYear', 2026),
    amendmentYear: pick(partial, 'amendmentYear', 2026),
    amount: parseMoney(partial.amount),
    measure: partial.measure ?? 'flow',
    linkConfirmed: pick(partial, 'linkConfirmed', true),
    reconciliationState: partial.reconciliationState ?? 'unreconciled',
    duplicateOfId: partial.duplicateOfId ?? null,
    evidenceIds: partial.evidenceIds ?? ['ev-1'],
    accessClass: 'public',
    isSynthetic: true,
  };
}

const periodo = dateRange(plainDate('2026-01-01'), plainDate('2026-12-31'));

function base(stage: FinancialStage) {
  return {
    stage,
    period: periodo,
    beneficiaryEntityId: null,
    subjectId: null,
    instrumentId: 'emenda-1',
    budgetYear: null,
    currency: 'BRL' as const,
    applyCancellations: true,
  };
}

describe('11.5 - o exemplo inteiramente ficticio do briefing', () => {
  // Emenda de R$ 1.000.000,00; R$ 600.000,00 transferidos ao fundo;
  // R$ 350.000,00 pagos pelo executor; R$ 50.000,00 devolvidos.
  // "O produto nao deve dizer que foram recebidos R$ 1.950.000,00."
  const transferido = event({ id: 'transf', stage: 'transferred', amount: '600.000,00', financialDocument: 'OB-1' });
  const events: FinancialEvent[] = [
    event({ stage: 'indicated', amount: '1.000.000,00' }),
    transferido,
    event({ stage: 'paid_supplier', amount: '350.000,00', financialDocument: 'OB-2' }),
    event({ stage: 'cancelled', amount: '50.000,00', cancelsEventId: 'transf', financialDocument: 'OB-3' }),
  ];

  test('as etapas nao se somam em um numero unico', () => {
    const indicado = computeTotal(events, base('indicated'));
    const transferidoTotal = computeTotal(events, base('transferred'));
    const pago = computeTotal(events, base('paid_supplier'));

    assert.equal(formatMoney(indicado.net), 'R$ 1.000.000,00');
    assert.equal(formatMoney(transferidoTotal.gross), 'R$ 600.000,00');
    assert.equal(formatMoney(transferidoTotal.cancellations), 'R$ 50.000,00');
    assert.equal(formatMoney(transferidoTotal.net), 'R$ 550.000,00');
    assert.equal(formatMoney(pago.net), 'R$ 350.000,00');

    // A soma proibida seria 1.000.000 + 600.000 + 350.000 = 1.950.000.
    const somaProibida =
      indicado.net.cents + transferidoTotal.gross.cents + pago.net.cents;
    assert.equal(somaProibida, 195_000_000n);
    // Nenhum total individual produz esse numero.
    for (const total of [indicado, transferidoTotal, pago]) {
      assert.notEqual(total.net.cents, 195_000_000n);
    }
  });

  test('etapa declaratoria e marcada como nao somavel com execucao', () => {
    const indicado = computeTotal(events, base('indicated'));
    assert.equal(indicado.notSummable, true);
    assert.match(indicado.warnings.join(' '), /nao dinheiro movimentado|nao somar/i);
  });

  test('T14 - a devolucao reduz apenas a etapa do evento que ela cancela', () => {
    // Este foi um defeito real durante a construcao: a anulacao era subtraida
    // de TODAS as etapas, produzindo "empenhado: -R$ 50.000,00".
    const empenhado = computeTotal(events, base('committed'));
    assert.equal(empenhado.includedEventIds.length, 0);
    assert.equal(empenhado.net.cents, 0n);
    assert.equal(formatMoney(computeTotal(events, base('paid_supplier')).cancellations), 'R$ 0,00');
  });

  test('anulacao sem vinculo nao entra em nenhum total e gera ressalva', () => {
    const soltos = [
      event({ id: 'x1', stage: 'transferred', amount: '600.000,00' }),
      event({ id: 'x2', stage: 'cancelled', amount: '50.000,00', cancelsEventId: null }),
    ];
    const total = computeTotal(soltos, base('transferred'));
    assert.equal(formatMoney(total.net), 'R$ 600.000,00');
    assert.match(total.warnings.join(' '), /nao esta vinculada/i);
    assert.ok(total.excluded.some((e) => e.reason === 'link_unconfirmed'));
  });

  test('a explicacao do total declara formula, universo e exclusoes (7.7)', () => {
    const texto = explainTotal(computeTotal(events, base('transferred')));
    assert.match(texto, /Formula:/);
    assert.match(texto, /Universo:/);
    assert.match(texto, /etapa=transferred/);
    assert.match(texto, /R\$ 550\.000,00/);
  });
});

describe('T13 - posicao acumulada', () => {
  test('fotografias sucessivas de saldo nao sao somadas', () => {
    const events = [
      event({ stage: 'transferred', amount: '200.000,00', measure: 'cumulative_position', factDate: plainDate('2026-05-31') }),
      event({ stage: 'transferred', amount: '400.000,00', measure: 'cumulative_position', factDate: plainDate('2026-06-30') }),
      event({ stage: 'transferred', amount: '600.000,00', measure: 'cumulative_position', factDate: plainDate('2026-07-31') }),
    ];
    const total = computeTotal(events, base('transferred'));
    // Somar daria R$ 1.200.000,00, que nunca existiu.
    assert.equal(total.net.cents, 0n);
    assert.equal(total.excluded.filter((e) => e.reason === 'cumulative_position').length, 3);
    assert.match(total.warnings.join(' '), /saldo, nao parcela/i);
  });
});

describe('T11 e T12 - deduplicacao', () => {
  test('T11 - mesmo pagamento em dois portais conta uma vez', () => {
    const a = event({ id: 'a', sourceId: 'src-a', externalId: 'A-1', stage: 'transferred', amount: '600.000,00', financialDocument: 'OB-7001' });
    const b = event({ id: 'b', sourceId: 'src-b', externalId: 'B-9', stage: 'transferred', amount: '600.000,00', financialDocument: 'OB-7001' });
    const decision = deduplicate([a, b]);
    assert.equal(decision.kept.length, 1);
    assert.equal(decision.duplicates.length, 1);
    assert.equal(decision.duplicates[0]?.method, 'cross_source_document');
    assert.equal(formatMoney(computeTotal(decision.kept, base('transferred')).net), 'R$ 600.000,00');
  });

  test('T12 - parcelas com data e valor iguais NAO sao deduplicadas automaticamente', () => {
    const a = event({ id: 'a', externalId: 'A-1', stage: 'paid_supplier', amount: '250.000,00', financialDocument: null });
    const b = event({ id: 'b', externalId: 'A-2', stage: 'paid_supplier', amount: '250.000,00', financialDocument: null });
    const decision = deduplicate([a, b]);
    assert.equal(decision.kept.length, 2, 'coincidencia de data e valor nao prova que e o mesmo pagamento');
    assert.equal(decision.duplicates.length, 0);
    assert.equal(decision.reviewCandidates.length, 1);
    assert.match(decision.reviewCandidates[0]?.reason ?? '', /parcelas distintas/i);
  });

  test('T38 - o mesmo lote repetido nao cria evento novo', () => {
    const a = event({ id: 'a', sourceId: 'src-a', externalId: 'A-1', stage: 'transferred', amount: '600.000,00' });
    const repetido = { ...a, id: 'a-copia' };
    const decision = deduplicate([a, repetido]);
    assert.equal(decision.kept.length, 1);
    assert.equal(decision.duplicates[0]?.method, 'source_key');
  });

  test('a chave entre fontes exige documento financeiro', () => {
    assert.equal(crossSourceKey(event({ stage: 'transferred', amount: '1,00' })), null);
    assert.notEqual(
      crossSourceKey(event({ stage: 'transferred', amount: '1,00', financialDocument: 'OB-1' })),
      null,
    );
    assert.match(sourceKey(event({ stage: 'transferred', amount: '1,00' })), /^src-a::/);
  });

  test('duplicata ja conciliada nunca entra no total', () => {
    const events = [
      event({ id: 'a', stage: 'transferred', amount: '600.000,00' }),
      event({ id: 'b', stage: 'transferred', amount: '600.000,00', reconciliationState: 'duplicate_of', duplicateOfId: 'a' }),
    ];
    const total = computeTotal(events, base('transferred'));
    assert.equal(formatMoney(total.net), 'R$ 600.000,00');
    assert.ok(total.excluded.some((e) => e.reason === 'duplicate'));
  });
});

describe('T15 - exercicios distintos', () => {
  test('pagamento em ano posterior a emenda preserva os filtros', () => {
    const events = [
      event({ stage: 'paid_supplier', amount: '100.000,00', factDate: plainDate('2026-03-10'), budgetYear: 2026, amendmentYear: 2025 }),
      event({ stage: 'paid_supplier', amount: '200.000,00', factDate: plainDate('2025-11-10'), budgetYear: 2025, amendmentYear: 2025 }),
    ];
    const so2026 = computeTotal(events, { ...base('paid_supplier'), budgetYear: 2026 });
    assert.equal(formatMoney(so2026.net), 'R$ 100.000,00');
    assert.ok(so2026.excluded.some((e) => e.reason === 'budget_year_mismatch'));
  });

  test('evento sem data do fato nao e colocado no periodo por suposicao', () => {
    const events = [event({ stage: 'transferred', amount: '10.000,00', factDate: null })];
    const total = computeTotal(events, base('transferred'));
    assert.equal(total.includedEventIds.length, 0);
    assert.ok(total.excluded.some((e) => e.reason === 'missing_fact_date'));
  });
});

describe('T08 - emenda coletiva', () => {
  test('o valor do instrumento nao e atribuido integralmente a cada integrante', () => {
    const total = parseMoney('1.000.000,00');
    const attribution = attributeCollective(total, [
      { personId: 'p1', documentedShare: null },
      { personId: 'p2', documentedShare: null },
      { personId: 'p3', documentedShare: null },
    ]);
    assert.equal(attribution.summableAcrossPeople, false);
    assert.equal(attribution.documentedSum.cents, 0n);
    assert.match(attribution.note, /nao pode ser atribuido integralmente/i);
    // A soma proibida seria R$ 3.000.000,00.
    assert.notEqual(attribution.instrumentTotal.cents * 3n, attribution.instrumentTotal.cents);
  });

  test('com parcelas individuais documentadas, os totais fecham e sao somaveis', () => {
    const attribution = attributeCollective(parseMoney('900.000,00'), [
      { personId: 'p1', documentedShare: parseMoney('300.000,00') },
      { personId: 'p2', documentedShare: parseMoney('300.000,00') },
      { personId: 'p3', documentedShare: parseMoney('300.000,00') },
    ]);
    assert.equal(attribution.summableAcrossPeople, true);
    assert.equal(attribution.unallocated.cents, 0n);
  });

  test('parcelas que excedem o instrumento viram conflito, nao total maior', () => {
    const attribution = attributeCollective(parseMoney('100.000,00'), [
      { personId: 'p1', documentedShare: parseMoney('80.000,00') },
      { personId: 'p2', documentedShare: parseMoney('80.000,00') },
    ]);
    assert.equal(attribution.summableAcrossPeople, false);
    assert.match(attribution.note, /conflito a revisar/i);
  });
});

describe('11.3 - cadeia de rastreabilidade', () => {
  test('semelhanca de valor, area ou data nao comprova a ligacao', () => {
    const links: ChainLink[] = [
      { fromStep: 'amendment', toStep: 'instrument', sharedIdentifier: null, evidenceIds: [], factDate: null },
    ];
    const assessment = assessChain(new Map([['amendment', ['ev-1']], ['instrument', ['ev-2']]]), links);
    assert.equal(assessment.complete, false);
    assert.equal(assessment.links[0]?.verdict, 'rejected_weak_signal');
    assert.match(assessment.gaps.join(' '), /semelhanca de valor/i);
  });

  test('identificador compartilhado documenta o elo', () => {
    const links: ChainLink[] = [
      { fromStep: 'amendment', toStep: 'instrument', sharedIdentifier: 'EX-0001/2026', evidenceIds: [], factDate: null },
    ];
    const assessment = assessChain(new Map([['amendment', ['ev-1']]]), links);
    assert.equal(assessment.links[0]?.verdict, 'documented');
  });

  test('elos ausentes aparecem como lacuna, nao como cadeia completa', () => {
    const assessment = assessChain(new Map([['amendment', ['ev-1']]]), []);
    assert.equal(assessment.complete, false);
    assert.ok(assessment.gaps.length >= 7);
  });
});

describe('regras gerais de total', () => {
  test('moeda diferente e excluida, nunca convertida em silencio', () => {
    const estrangeiro = { ...event({ stage: 'transferred', amount: '100,00' }), amount: money(10_000n, 'BRL') };
    const total = computeTotal([{ ...estrangeiro, amount: { cents: 10_000n, currency: 'USD' } as never }], base('transferred'));
    assert.equal(total.includedEventIds.length, 0);
    assert.ok(total.excluded.some((e) => e.reason === 'currency_mismatch'));
  });

  test('o universo declarado inclui quantos registros foram avaliados', () => {
    const events = [event({ stage: 'transferred', amount: '1,00' }), event({ stage: 'committed', amount: '2,00' })];
    const total = computeTotal(events, base('transferred'));
    assert.match(total.universe, /registros_avaliados=2/);
  });
});
