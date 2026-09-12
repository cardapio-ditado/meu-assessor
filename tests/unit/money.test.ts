/**
 * Briefing 22.3: "Testes unitarios para normalizacao, datas, moedas,
 * deduplicacao e regras."
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  formatMoney,
  fromDecimalString,
  money,
  MoneyError,
  parseMoney,
  subtract,
  sum,
  toDecimalString,
} from '../../packages/domain/src/money.ts';

describe('moeda', () => {
  test('le a grafia pt-BR e a internacional sem passar por float', () => {
    assert.equal(parseMoney('R$ 1.234,56').cents, 123456n);
    assert.equal(parseMoney('1234.56').cents, 123456n);
    assert.equal(parseMoney('1.000').cents, 100000n);
    assert.equal(parseMoney('1234').cents, 123400n);
    assert.equal(parseMoney('-50,00').cents, -5000n);
    assert.equal(parseMoney('(50,00)').cents, -5000n);
  });

  test('1.000.000,00 nao vira 1000 nem 1,00', () => {
    assert.equal(formatMoney(parseMoney('1.000.000,00')), 'R$ 1.000.000,00');
  });

  test('rejeita valor vazio: ausencia e null com motivo, nao zero (10.4)', () => {
    assert.throws(() => parseMoney(''), MoneyError);
    assert.throws(() => parseMoney('   '), MoneyError);
  });

  test('rejeita fracao ambigua em vez de arredondar em silencio', () => {
    assert.throws(() => parseMoney('10,1234'), MoneyError);
  });

  test('rejeita texto nao numerico', () => {
    assert.throws(() => parseMoney('cerca de mil reais'), MoneyError);
  });

  test('soma de centavos nao acumula erro de ponto flutuante', () => {
    // 0.1 + 0.2 em float binario nao da 0.3. Em centavos, da.
    const total = sum([parseMoney('0,10'), parseMoney('0,20')]);
    assert.equal(total.cents, 30n);
    assert.equal(formatMoney(total), 'R$ 0,30');

    // Um caso realista: 1201 parcelas de R$ 0,07.
    const parcelas = Array.from({ length: 1201 }, () => parseMoney('0,07'));
    assert.equal(sum(parcelas).cents, 8407n);
  });

  test('nao soma moedas diferentes por conveniencia', () => {
    const brl = money(100n, 'BRL');
    const outra = { cents: 100n, currency: 'USD' } as unknown as typeof brl;
    assert.throws(() => add(brl, outra), MoneyError);
  });

  test('ida e volta pelo banco preserva o valor exato', () => {
    for (const raw of ['0,01', '999.999.999,99', '1.000.000,00', '-50,00']) {
      const value = parseMoney(raw);
      assert.equal(fromDecimalString(toDecimalString(value)).cents, value.cents);
    }
  });

  test('subtracao de devolucao mantem exatidao', () => {
    const bruto = parseMoney('600.000,00');
    const devolvido = parseMoney('50.000,00');
    assert.equal(formatMoney(subtract(bruto, devolvido)), 'R$ 550.000,00');
  });
});
