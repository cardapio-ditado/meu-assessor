/**
 * Valores monetarios. Briefing 10.4: "decimal exato ou centavos inteiros,
 * nunca ponto flutuante binario para calculos financeiros".
 *
 * Representamos como centavos em BigInt. A moeda viaja junto do valor: somar
 * moedas diferentes e erro, nao conversao implicita.
 */

export type CurrencyCode = 'BRL';

export interface Money {
  readonly cents: bigint;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {}

export function money(cents: bigint | number, currency: CurrencyCode = 'BRL'): Money {
  if (typeof cents === 'number') {
    if (!Number.isInteger(cents)) {
      throw new MoneyError(`centavos precisam ser inteiros; recebido ${cents}`);
    }
    return { cents: BigInt(cents), currency };
  }
  return { cents, currency };
}

/**
 * Converte a grafia da fonte para centavos sem passar por float.
 * Aceita "1.234,56", "1234.56", "1234", "R$ 1.234,56", "-50,00".
 * Nao aceita valor ambiguo ou vazio: a ausencia deve virar null com motivo
 * (briefing 10.4), nao zero.
 */
export function parseMoney(raw: string, currency: CurrencyCode = 'BRL'): Money {
  const text = raw.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (text === '') throw new MoneyError('valor vazio: use null com motivo, nao zero');

  const negative = text.startsWith('-') || (text.startsWith('(') && text.endsWith(')'));
  const digitsOnly = text.replace(/[()\-+]/g, '');
  if (!/^[\d.,]+$/.test(digitsOnly)) {
    throw new MoneyError(`valor nao numerico: ${JSON.stringify(raw)}`);
  }

  const lastComma = digitsOnly.lastIndexOf(',');
  const lastDot = digitsOnly.lastIndexOf('.');
  let integerPart: string;
  let fractionPart: string;

  const decimalSep = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : '';
  if (decimalSep === '') {
    integerPart = digitsOnly;
    fractionPart = '';
  } else {
    const at = decimalSep === ',' ? lastComma : lastDot;
    const tail = digitsOnly.slice(at + 1);
    // Separador de milhar tem exatamente 3 digitos depois; decimal tem 1 ou 2.
    if (tail.length === 3 && digitsOnly.slice(0, at).length > 0 && !digitsOnly.slice(0, at).includes(decimalSep)) {
      const otherSep = decimalSep === ',' ? '.' : ',';
      if (!digitsOnly.includes(otherSep)) {
        integerPart = digitsOnly.replace(/[.,]/g, '');
        fractionPart = '';
      } else {
        integerPart = digitsOnly.slice(0, at).replace(/[.,]/g, '');
        fractionPart = tail;
      }
    } else {
      if (tail.length > 2) {
        throw new MoneyError(`fracao com ${tail.length} digitos e ambigua: ${JSON.stringify(raw)}`);
      }
      integerPart = digitsOnly.slice(0, at).replace(/[.,]/g, '');
      fractionPart = tail;
    }
  }

  if (integerPart === '') integerPart = '0';
  const cents = BigInt(integerPart) * 100n + BigInt((fractionPart + '00').slice(0, 2));
  return { cents: negative ? -cents : cents, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`moedas diferentes: ${a.currency} e ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { cents: a.cents - b.cents, currency: a.currency };
}

export function negate(a: Money): Money {
  return { cents: -a.cents, currency: a.currency };
}

export function sum(values: readonly Money[], currency: CurrencyCode = 'BRL'): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), money(0n, currency));
}

export function isZero(a: Money): boolean {
  return a.cents === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0;
}

/** Grafia pt-BR para exibicao. Nunca usada como entrada de calculo. */
export function formatMoney(a: Money): string {
  const negative = a.cents < 0n;
  const abs = negative ? -a.cents : a.cents;
  const reais = abs / 100n;
  const cents = abs % 100n;
  const grouped = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const symbol = a.currency === 'BRL' ? 'R$ ' : `${a.currency} `;
  return `${negative ? '-' : ''}${symbol}${grouped},${cents.toString().padStart(2, '0')}`;
}

/** Serializacao para o banco: string decimal exata, nunca float. */
export function toDecimalString(a: Money): string {
  const negative = a.cents < 0n;
  const abs = negative ? -a.cents : a.cents;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function fromDecimalString(value: string, currency: CurrencyCode = 'BRL'): Money {
  return parseMoney(value, currency);
}
