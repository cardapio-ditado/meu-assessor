/**
 * Datas: os sete papeis do briefing 12.2 e a regra 10.4 de nao inventar
 * horario para uma data.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  dateRange,
  isValidOn,
  plainDate,
  TemporalError,
  todayIn,
  tryPlainDate,
  withinRange,
  DATE_FACETS,
} from '../../packages/domain/src/temporal.ts';

describe('datas', () => {
  test('exige YYYY-MM-DD e rejeita data inexistente', () => {
    assert.equal(plainDate('2026-02-28'), '2026-02-28');
    assert.throws(() => plainDate('2026-02-30'), TemporalError);
    assert.throws(() => plainDate('28/02/2026'), TemporalError);
    assert.throws(() => plainDate('2026-02-28T00:00:00Z'), TemporalError);
  });

  test('ano bissexto e tratado corretamente', () => {
    assert.equal(plainDate('2024-02-29'), '2024-02-29');
    assert.throws(() => plainDate('2026-02-29'), TemporalError);
  });

  test('tryPlainDate devolve null em vez de lancar, para campos opcionais', () => {
    assert.equal(tryPlainDate(null), null);
    assert.equal(tryPlainDate(''), null);
    assert.equal(tryPlainDate('nao informado'), null);
    assert.equal(tryPlainDate('2026-09-12'), '2026-09-12');
  });

  test('aritmetica de dias atravessa mes e ano', () => {
    assert.equal(addDays(plainDate('2026-12-28'), 5), '2027-01-02');
    assert.equal(daysBetween(plainDate('2026-02-28'), plainDate('2026-03-01')), 1);
    assert.equal(daysBetween(plainDate('2024-02-28'), plainDate('2024-03-01')), 2);
  });

  test('a data de hoje respeita o fuso do municipio, nao o do servidor', () => {
    // 03:00 UTC de 12/09 ainda e 11/09 em Cuiaba (UTC-4).
    const reference = new Date('2026-09-12T03:00:00Z');
    assert.equal(todayIn('America/Cuiaba', reference), '2026-09-11');
    assert.equal(todayIn('UTC', reference), '2026-09-12');
  });

  test('intervalo invertido e erro, nao intervalo vazio silencioso', () => {
    assert.throws(() => dateRange(plainDate('2026-09-12'), plainDate('2026-09-01')), TemporalError);
  });

  test('pertencimento ao intervalo inclui as bordas', () => {
    const range = dateRange(plainDate('2026-09-01'), plainDate('2026-09-12'));
    assert.equal(withinRange(plainDate('2026-09-01'), range), true);
    assert.equal(withinRange(plainDate('2026-09-12'), range), true);
    assert.equal(withinRange(plainDate('2026-08-31'), range), false);
  });

  test('vigencia sem termo conhecido devolve null, nao "vigente para sempre"', () => {
    // A.3: "sem inventar limites".
    assert.equal(isValidOn({ validFrom: null, validTo: null }, plainDate('2026-09-12')), null);
    assert.equal(
      isValidOn({ validFrom: plainDate('2025-03-01'), validTo: null }, plainDate('2026-09-12')),
      true,
    );
    assert.equal(
      isValidOn({ validFrom: plainDate('2025-03-01'), validTo: plainDate('2025-12-31') }, plainDate('2026-09-12')),
      false,
    );
  });

  test('os sete papeis de data do 12.2 estao declarados', () => {
    assert.deepEqual(
      [...DATE_FACETS],
      [
        'fact_date',
        'publication_date',
        'reference_period',
        'validity',
        'collected_at',
        'validated_at',
        'superseded_at',
      ],
    );
  });
});
