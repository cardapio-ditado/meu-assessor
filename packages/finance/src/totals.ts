/**
 * Totais financeiros. Briefing 11.4: "Todo total deve ter formula, conjunto de
 * registros, periodo, etapa financeira, moeda, entidade beneficiaria e regras
 * para anulacoes. Executar calculos em codigo ou SQL controlado. A IA deve
 * explicar o resultado, nao somar valores por interpretacao de paragrafos."
 *
 * Nada aqui chama um modelo. A funcao recebe eventos e devolve um total
 * auditavel com a lista de registros incluidos e excluidos.
 */
import {
  add,
  compare,
  formatMoney,
  money,
  type CurrencyCode,
  type Money,
} from '../../domain/src/money.ts';
import { daysBetween, type DateRange, type PlainDate } from '../../domain/src/temporal.ts';
import {
  NON_FINANCIAL_STAGES,
  type FinancialStage,
} from '../../domain/src/states.ts';
import type { FinancialEvent } from '../../domain/src/types.ts';

export interface TotalRequest {
  readonly stage: FinancialStage;
  readonly period: DateRange | null;
  readonly beneficiaryEntityId: string | null;
  readonly subjectId: string | null;
  readonly instrumentId: string | null;
  readonly budgetYear: number | null;
  readonly currency: CurrencyCode;
  /** 11.4: anulacoes reduzem o total bruto para chegar ao liquido. */
  readonly applyCancellations: boolean;
}

export interface ExcludedEvent {
  readonly eventId: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export type ExclusionReason =
  | 'stage_mismatch'
  | 'outside_period'
  | 'missing_fact_date'
  | 'beneficiary_mismatch'
  | 'subject_mismatch'
  | 'instrument_mismatch'
  | 'budget_year_mismatch'
  | 'duplicate'
  | 'cumulative_position'
  | 'currency_mismatch'
  | 'link_unconfirmed';

export interface TotalResult {
  readonly formula: string;
  readonly stage: FinancialStage;
  readonly gross: Money;
  readonly cancellations: Money;
  readonly net: Money;
  readonly includedEventIds: readonly string[];
  readonly excluded: readonly ExcludedEvent[];
  readonly evidenceIds: readonly string[];
  readonly universe: string;
  readonly notSummable: boolean;
  readonly warnings: readonly string[];
  readonly latestFactDate: PlainDate | null;
}

/**
 * 11.4: "Se uma API informa saldo acumulado em cada atualizacao, nao somar
 * fotografias sucessivas." Posicoes acumuladas nunca entram numa soma: usa-se
 * a observacao mais recente do universo pedido.
 */
function partitionByMeasure(events: readonly FinancialEvent[]): {
  flows: FinancialEvent[];
  positions: FinancialEvent[];
} {
  const flows: FinancialEvent[] = [];
  const positions: FinancialEvent[] = [];
  for (const e of events) {
    (e.measure === 'cumulative_position' ? positions : flows).push(e);
  }
  return { flows, positions };
}

export function computeTotal(
  events: readonly FinancialEvent[],
  request: TotalRequest,
): TotalResult {
  const excluded: ExcludedEvent[] = [];
  const warnings: string[] = [];
  const zero = money(0n, request.currency);

  // Uma anulacao pertence a etapa do evento que ela cancela. Sem esse vinculo
  // ela nao pode ser subtraida de uma etapa escolhida por conveniencia: isso
  // produziria "empenhado: -R$ 50.000,00" para uma devolucao de repasse.
  // Briefing 11.4 (toda formula declara a etapa) e T14 (mostrar evento,
  // vinculo e efeito no total ADEQUADO).
  const stageById = new Map<string, FinancialStage>();
  for (const e of events) stageById.set(e.id, e.stage);

  const keep: FinancialEvent[] = [];
  for (const e of events) {
    if (e.reconciliationState === 'duplicate_of') {
      excluded.push({ eventId: e.id, reason: 'duplicate', detail: `conciliado como duplicata de ${e.duplicateOfId ?? 'registro nao informado'}` });
      continue;
    }
    if (e.amount.currency !== request.currency) {
      excluded.push({ eventId: e.id, reason: 'currency_mismatch', detail: `moeda ${e.amount.currency}` });
      continue;
    }
    const isCancellation = e.stage === 'cancelled';
    if (isCancellation) {
      const cancelledStage = e.cancelsEventId === null ? null : stageById.get(e.cancelsEventId) ?? null;
      if (cancelledStage === null) {
        excluded.push({
          eventId: e.id,
          reason: 'link_unconfirmed',
          detail: 'anulacao sem vinculo com o evento original: nao aplicada a nenhum total',
        });
        warnings.push(
          `Anulacao ou devolucao ${e.externalId} nao esta vinculada a um evento original e ficou fora do calculo. ` +
            'O registro continua visivel no historico.',
        );
        continue;
      }
      if (cancelledStage !== request.stage) {
        excluded.push({
          eventId: e.id,
          reason: 'stage_mismatch',
          detail: `anulacao referente a etapa ${cancelledStage}`,
        });
        continue;
      }
    } else if (e.stage !== request.stage) {
      excluded.push({ eventId: e.id, reason: 'stage_mismatch', detail: `etapa ${e.stage}` });
      continue;
    }
    if (request.beneficiaryEntityId !== null && e.payeeEntityId !== request.beneficiaryEntityId) {
      excluded.push({ eventId: e.id, reason: 'beneficiary_mismatch', detail: `destinatario ${e.payeeEntityId ?? 'nao informado'}` });
      continue;
    }
    if (request.subjectId !== null && e.subjectId !== request.subjectId) {
      excluded.push({ eventId: e.id, reason: 'subject_mismatch', detail: `assunto ${e.subjectId ?? 'nao vinculado'}` });
      continue;
    }
    if (request.instrumentId !== null && e.instrumentId !== request.instrumentId) {
      excluded.push({ eventId: e.id, reason: 'instrument_mismatch', detail: `instrumento ${e.instrumentId ?? 'nao vinculado'}` });
      continue;
    }
    if (request.budgetYear !== null && e.budgetYear !== request.budgetYear) {
      excluded.push({ eventId: e.id, reason: 'budget_year_mismatch', detail: `exercicio ${e.budgetYear ?? 'nao informado'}` });
      continue;
    }
    if (request.period !== null) {
      if (e.factDate === null) {
        excluded.push({ eventId: e.id, reason: 'missing_fact_date', detail: 'sem data do fato; nao assumir periodo' });
        continue;
      }
      const inside =
        daysBetween(request.period.from, e.factDate) >= 0 &&
        daysBetween(e.factDate, request.period.to) >= 0;
      if (!inside) {
        excluded.push({ eventId: e.id, reason: 'outside_period', detail: `data do fato ${e.factDate}` });
        continue;
      }
    }
    keep.push(e);
  }

  const { flows, positions } = partitionByMeasure(keep);
  for (const p of positions) {
    excluded.push({
      eventId: p.id,
      reason: 'cumulative_position',
      detail: 'posicao acumulada: nao somavel com fluxos',
    });
  }
  if (positions.length > 0) {
    warnings.push(
      `${positions.length} registro(s) de posicao acumulada foram mantidos fora da soma; a fonte informa saldo, nao parcela.`,
    );
  }

  let gross = zero;
  let cancellations = zero;
  const included: string[] = [];
  const evidenceIds = new Set<string>();
  let latestFactDate: PlainDate | null = null;

  for (const e of flows) {
    const isCancellation = e.stage === 'cancelled';
    // Uma anulacao pode chegar com valor negativo da fonte ou positivo com
    // sinal implicito na etapa. Normalizamos para magnitude positiva aqui.
    const magnitude = e.amount.cents < 0n ? money(-e.amount.cents, e.amount.currency) : e.amount;
    if (isCancellation) {
      if (!request.applyCancellations) {
        excluded.push({ eventId: e.id, reason: 'stage_mismatch', detail: 'anulacao excluida por pedido explicito' });
        continue;
      }
      cancellations = add(cancellations, magnitude);
    } else {
      gross = add(gross, magnitude);
    }
    included.push(e.id);
    for (const ev of e.evidenceIds) evidenceIds.add(ev);
    if (e.factDate !== null && (latestFactDate === null || daysBetween(latestFactDate, e.factDate) > 0)) {
      latestFactDate = e.factDate;
    }
    if (!e.linkConfirmed && (request.subjectId !== null || request.instrumentId !== null)) {
      warnings.push(`Registro ${e.externalId} tem vinculo nao confirmado com o objeto consultado.`);
    }
  }

  const net = money(gross.cents - cancellations.cents, request.currency);
  const notSummable = NON_FINANCIAL_STAGES.includes(request.stage);
  if (notSummable) {
    warnings.push(
      'Esta etapa registra declaracao ou autorizacao, nao dinheiro movimentado. Nao somar com etapas de execucao.',
    );
  }

  const universeParts = [
    `etapa=${request.stage}`,
    request.period ? `periodo=${request.period.from}..${request.period.to}` : 'periodo=todo o disponivel',
    request.beneficiaryEntityId ? `destinatario=${request.beneficiaryEntityId}` : 'destinatario=qualquer',
    request.subjectId ? `assunto=${request.subjectId}` : 'assunto=qualquer',
    request.budgetYear !== null ? `exercicio=${request.budgetYear}` : 'exercicio=qualquer',
    `moeda=${request.currency}`,
    `registros_avaliados=${events.length}`,
  ];

  return {
    formula: request.applyCancellations
      ? 'liquido = soma(fluxos da etapa) - soma(anulacoes vinculadas)'
      : 'bruto = soma(fluxos da etapa); anulacoes nao aplicadas',
    stage: request.stage,
    gross,
    cancellations,
    net,
    includedEventIds: included,
    excluded,
    evidenceIds: [...evidenceIds],
    universe: universeParts.join('; '),
    notSummable,
    warnings,
    latestFactDate,
  };
}

/** Texto do botao "Como este total foi calculado?" (7.7). */
export function explainTotal(result: TotalResult): string {
  const lines = [
    `Formula: ${result.formula}`,
    `Universo: ${result.universe}`,
    `Registros incluidos: ${result.includedEventIds.length}`,
    `Bruto: ${formatMoney(result.gross)}`,
    `Anulacoes / devolucoes: ${formatMoney(result.cancellations)}`,
    `Resultado: ${formatMoney(result.net)}`,
  ];
  if (result.latestFactDate !== null) lines.push(`Data do fato mais recente: ${result.latestFactDate}`);
  const byReason = new Map<ExclusionReason, number>();
  for (const e of result.excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  if (byReason.size > 0) {
    lines.push('Exclusoes:');
    for (const [reason, count] of byReason) lines.push(`  - ${reason}: ${count}`);
  }
  for (const w of result.warnings) lines.push(`Ressalva: ${w}`);
  return lines.join('\n');
}

/**
 * 11.2 / E.2: totais por perfil de agente publico nao sao somaveis quando a
 * emenda e coletiva. Devolve o valor oficial e a indicacao individual, sem
 * multiplicar por integrante (T08).
 */
export interface CollectiveShare {
  readonly personId: string;
  readonly documentedShare: Money | null;
}

export interface CollectiveAttribution {
  readonly instrumentTotal: Money;
  readonly participants: readonly CollectiveShare[];
  readonly documentedSum: Money;
  readonly unallocated: Money;
  readonly summableAcrossPeople: boolean;
  readonly note: string;
}

export function attributeCollective(
  instrumentTotal: Money,
  participants: readonly CollectiveShare[],
): CollectiveAttribution {
  const documented = participants.reduce<Money>(
    (acc, p) => (p.documentedShare === null ? acc : add(acc, p.documentedShare)),
    money(0n, instrumentTotal.currency),
  );
  const anyUndocumented = participants.some((p) => p.documentedShare === null);
  const unallocated = money(instrumentTotal.cents - documented.cents, instrumentTotal.currency);
  const overAllocated = compare(documented, instrumentTotal) > 0;

  const note = overAllocated
    ? 'As parcelas documentadas somam mais que o instrumento: conflito a revisar antes de exibir total.'
    : anyUndocumented
      ? 'Ha integrantes sem parcela individual documentada. O valor do instrumento nao pode ser atribuido integralmente a cada um.'
      : 'Parcelas individuais documentadas para todos os integrantes.';

  return {
    instrumentTotal,
    participants,
    documentedSum: documented,
    unallocated,
    // Somavel entre pessoas apenas se toda parcela for documentada e fechar.
    summableAcrossPeople: !anyUndocumented && !overAllocated,
    note,
  };
}
