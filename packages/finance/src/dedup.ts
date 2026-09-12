/**
 * Deduplicacao e conciliacao. Briefing A.4: "Nao usar simplesmente data +
 * valor como identificador, pois pagamentos distintos podem coincidir" (T12),
 * mas o mesmo pagamento publicado em dois portais conta uma vez (T11).
 *
 * A regra e: so deduplicamos com identificador compartilhado ou correspondencia
 * curada. Coincidencia de data e valor gera CANDIDATO para revisao, nunca uniao
 * automatica.
 */
import { toDecimalString } from '../../domain/src/money.ts';
import type { FinancialEvent } from '../../domain/src/types.ts';

/** Chave estavel por fonte: repetir o lote nao cria registro novo (13.3). */
export function sourceKey(event: FinancialEvent): string {
  return `${event.sourceId}::${event.externalId}`;
}

/**
 * Chave de conciliacao entre fontes. Exige documento financeiro (ordem
 * bancaria, nota de empenho) — o identificador que atravessa portais.
 */
export function crossSourceKey(event: FinancialEvent): string | null {
  if (event.financialDocument === null || event.financialDocument.trim() === '') return null;
  return [
    event.financialDocument.trim().toUpperCase(),
    event.stage,
    event.payerEntityId ?? '-',
    event.payeeEntityId ?? '-',
    event.budgetYear ?? '-',
  ].join('|');
}

export interface DedupDecision {
  readonly kept: readonly FinancialEvent[];
  readonly duplicates: readonly { readonly event: FinancialEvent; readonly duplicateOfId: string; readonly method: 'source_key' | 'cross_source_document' }[];
  /** Coincidencias que NAO autorizam uniao automatica (T12). */
  readonly reviewCandidates: readonly { readonly aId: string; readonly bId: string; readonly reason: string }[];
}

export function deduplicate(events: readonly FinancialEvent[]): DedupDecision {
  const bySourceKey = new Map<string, FinancialEvent>();
  const byCrossKey = new Map<string, FinancialEvent>();
  const kept: FinancialEvent[] = [];
  const duplicates: { event: FinancialEvent; duplicateOfId: string; method: 'source_key' | 'cross_source_document' }[] = [];

  for (const e of events) {
    const sk = sourceKey(e);
    const existingSame = bySourceKey.get(sk);
    if (existingSame !== undefined) {
      duplicates.push({ event: e, duplicateOfId: existingSame.id, method: 'source_key' });
      continue;
    }
    const ck = crossSourceKey(e);
    if (ck !== null) {
      const existingCross = byCrossKey.get(ck);
      if (existingCross !== undefined && existingCross.sourceId !== e.sourceId) {
        duplicates.push({ event: e, duplicateOfId: existingCross.id, method: 'cross_source_document' });
        bySourceKey.set(sk, existingCross);
        continue;
      }
      if (existingCross === undefined) byCrossKey.set(ck, e);
    }
    bySourceKey.set(sk, e);
    kept.push(e);
  }

  // Coincidencias suspeitas entre os mantidos: mesma data, valor, etapa e
  // partes, sem documento financeiro que prove serem o mesmo evento.
  const reviewCandidates: { aId: string; bId: string; reason: string }[] = [];
  const buckets = new Map<string, FinancialEvent[]>();
  for (const e of kept) {
    const k = [
      e.factDate ?? '-',
      toDecimalString(e.amount),
      e.stage,
      e.payerEntityId ?? '-',
      e.payeeEntityId ?? '-',
    ].join('|');
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [e]);
    else list.push(e);
  }
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i += 1) {
      const a = group[0];
      const b = group[i];
      if (a === undefined || b === undefined) continue;
      reviewCandidates.push({
        aId: a.id,
        bId: b.id,
        reason:
          'data, valor, etapa e partes coincidem, mas nao ha documento financeiro compartilhado. Podem ser parcelas distintas; mantidos separados para revisao.',
      });
    }
  }

  return { kept, duplicates, reviewCandidates };
}
