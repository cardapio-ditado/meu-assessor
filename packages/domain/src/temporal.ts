/**
 * Eixos temporais. Briefing 12.2: sete conceitos de data que nao podem ser
 * confundidos, e dois eixos preservados (validade administrativa x
 * conhecimento da plataforma).
 *
 * Regra 10.4: "Datas sem horario permanecem datas; nao inventar meia-noite
 * como momento do fato." Por isso PlainDate e string ISO 'YYYY-MM-DD' e nunca
 * Date. Timestamps tecnicos ficam em UTC e sao exibidos no fuso do municipio.
 */

export type PlainDate = string & { readonly __plainDate: unique symbol };
export type Instant = string & { readonly __instant: unique symbol };

export class TemporalError extends Error {}

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function plainDate(value: string): PlainDate {
  const m = PLAIN_DATE.exec(value);
  if (!m) throw new TemporalError(`data sem horario esperada em YYYY-MM-DD; recebido ${JSON.stringify(value)}`);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(mo) - 1 ||
    probe.getUTCDate() !== Number(d)
  ) {
    throw new TemporalError(`data inexistente: ${value}`);
  }
  return value as PlainDate;
}

export function tryPlainDate(value: string | null | undefined): PlainDate | null {
  if (value == null || value === '') return null;
  try {
    return plainDate(value);
  } catch {
    return null;
  }
}

export function instant(value: string | Date): Instant {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TemporalError(`instante invalido: ${String(value)}`);
  return d.toISOString() as Instant;
}

export function now(): Instant {
  return new Date().toISOString() as Instant;
}

export function daysBetween(from: PlainDate, to: PlainDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const base = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(base).toISOString().slice(0, 10) as PlainDate;
}

/** Data do relogio, no fuso do municipio, sem inventar horario. */
export function todayIn(timeZone: string, reference: Date = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(reference);
  return plainDate(parts);
}

export interface DateRange {
  readonly from: PlainDate;
  readonly to: PlainDate;
}

export function dateRange(from: PlainDate, to: PlainDate): DateRange {
  if (daysBetween(from, to) < 0) throw new TemporalError(`intervalo invertido: ${from} > ${to}`);
  return { from, to };
}

export function withinRange(date: PlainDate, range: DateRange): boolean {
  return daysBetween(range.from, date) >= 0 && daysBetween(date, range.to) >= 0;
}

/**
 * Vigencia administrativa aberta. valid_to null significa "sem termo
 * conhecido", nao "vigente para sempre" (briefing A.3: nao inventar limites).
 */
export interface ValidityInterval {
  readonly validFrom: PlainDate | null;
  readonly validTo: PlainDate | null;
}

export function isValidOn(interval: ValidityInterval, at: PlainDate): boolean | null {
  if (interval.validFrom === null && interval.validTo === null) return null;
  if (interval.validFrom !== null && daysBetween(interval.validFrom, at) < 0) return false;
  if (interval.validTo !== null && daysBetween(at, interval.validTo) < 0) return false;
  return true;
}

/**
 * Os sete papeis de data do briefing 12.2. O nome do campo carrega a pergunta
 * que ele responde; codigo que recebe DateFacet nao pode trocar um pelo outro.
 */
export const DATE_FACETS = [
  'fact_date',        // quando o ato, pagamento ou medicao ocorreu
  'publication_date', // quando a fonte tornou o registro publico
  'reference_period',  // a que periodo o numero se refere (competencia)
  'validity',         // intervalo em que o vinculo produz efeitos
  'collected_at',     // quando a plataforma obteve esta versao
  'validated_at',     // quando e por qual metodo o fato foi aprovado
  'superseded_at',    // quando outra versao passou a substituir esta
] as const;

export type DateFacet = (typeof DATE_FACETS)[number];
