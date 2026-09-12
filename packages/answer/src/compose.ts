/**
 * Montagem da resposta em quatro camadas (6.4). Regra dura do briefing:
 * "O aprofundamento nao pode contradizer o resumo por usar outra versao dos
 * dados. Todas as camadas devem apontar para o MESMO conjunto de evidencias."
 *
 * Por isso as quatro camadas sao derivadas de UM conjunto de afirmacoes; nao
 * ha segunda consulta entre o resumo e o detalhe.
 *
 * Este modulo nao chama modelo de linguagem. Produz o texto deterministico que
 * o produto usa quando AI_PROVIDER=none e, quando ha provedor, produz o
 * material que o redator recebe (C.5) e o validador confere.
 */
import { formatMoney } from '../../domain/src/money.ts';
import { EVIDENCE_STATE_LABEL, FINANCIAL_STAGE_LABEL } from '../../domain/src/states.ts';
import type { EvidenceState, FinancialStage } from '../../domain/src/states.ts';
import { daysBetween, type PlainDate } from '../../domain/src/temporal.ts';
import type {
  AnswerClaim,
  AnswerEnvelope,
  AnswerLayers,
  Claim,
  Entity,
  LabeledFact,
  TimelineItem,
} from '../../domain/src/types.ts';
import type { TotalResult } from '../../finance/src/totals.ts';
import type { QueryPlan } from './planner.ts';

export interface ComposeInput {
  readonly plan: QueryPlan;
  readonly subject: Entity | null;
  readonly claims: readonly Claim[];
  readonly timeline: readonly TimelineItem[];
  readonly totals: readonly { readonly stage: FinancialStage; readonly result: TotalResult }[];
  readonly gaps: readonly string[];
  readonly conflicts: readonly string[];
  readonly municipalityName: string;
  readonly today: PlainDate;
  readonly dataVersion: string;
  readonly sourceCheckedAt: string | null;
  readonly containsSynthetic: boolean;
}

const PREDICATE_LABEL: Record<string, string> = {
  status: 'Situacao documentada',
  physical_progress: 'Percentual fisico medido',
  contract_number: 'Contrato',
  contract_validity_end: 'Vigencia do contrato',
  contracted_amount: 'Valor contratado',
  supplier: 'Executor contratado',
  responsible_organ: 'Area responsavel',
  object: 'Objeto',
  location: 'Localizacao',
  authorship: 'Autoria',
  publication_date: 'Publicacao',
  authorized_amount: 'Valor autorizado pela emenda',
};

function labelFor(predicate: string): string {
  return PREDICATE_LABEL[predicate] ?? predicate.replace(/_/g, ' ');
}

function claimValueText(claim: Claim): string {
  if (claim.valueType === 'null') {
    return `nao localizado (${claim.nullReason ?? 'motivo nao registrado'})`;
  }
  if (claim.valueType === 'money' && claim.money !== null) {
    return formatMoney(claim.money);
  }
  if (claim.value === null) return 'nao informado';
  const text = String(claim.value);
  return claim.unit !== null ? `${text} ${claim.unit}` : text;
}

/** Ressalva de idade da evidencia. Aparece junto do fato, nao no rodape (6.1). */
function ageCaveat(claim: Claim, today: PlainDate): string | null {
  if (claim.factDate === null) return 'sem data do fato registrada';
  const age = daysBetween(claim.factDate, today);
  if (age <= 0) return null;
  if (claim.freshnessClass === 'stable_history') return null;
  if (age <= 7) return null;
  return `ultimo registro desta situacao: ${claim.factDate} (${age} dias)`;
}

function worstState(states: readonly EvidenceState[]): EvidenceState {
  const order: EvidenceState[] = [
    'documented',
    'source_reported',
    'partial',
    'stale_for_question',
    'divergent',
    'not_located',
  ];
  return states.reduce<EvidenceState>(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    'documented',
  );
}

/**
 * Camada 1 (6.4): "Aproximadamente 40 a 70 palavras como ponto de partida."
 * A funcao nao corta no meio de uma ressalva material: se a ressalva nao cabe,
 * o fato secundario sai antes dela.
 */
function buildBrief(input: ComposeInput, primary: readonly Claim[]): string {
  const { subject, municipalityName, today } = input;
  if (subject === null) {
    return `Nao localizei um assunto correspondente na base de ${municipalityName} dentro do recorte consultado (${input.plan.period.from} a ${input.plan.period.to}).`;
  }

  const parts: string[] = [];
  parts.push(`${subject.officialName}.`);

  const status = primary.find((c) => c.predicate === 'status');
  if (status !== undefined) {
    parts.push(`Situacao documentada: ${claimValueText(status)}.`);
    const caveat = ageCaveat(status, today);
    if (caveat !== null) parts.push(`${caveat[0]?.toUpperCase()}${caveat.slice(1)}.`);
  }

  for (const total of input.totals) {
    if (total.result.includedEventIds.length === 0) continue;
    parts.push(
      `${FINANCIAL_STAGE_LABEL[total.stage]}: ${formatMoney(total.result.net)} em ${total.result.includedEventIds.length} registro(s).`,
    );
  }

  if (input.conflicts.length > 0) {
    parts.push(`Ha ${input.conflicts.length} divergencia(s) nao resolvida(s) neste assunto.`);
  }
  if (input.gaps.length > 0) {
    parts.push(`${input.gaps.length} campo(s) nao confirmado(s).`);
  }
  if (input.containsSynthetic) {
    parts.push('Recorte de demonstracao com dados ficticios identificados.');
  }

  return parts.join(' ');
}

function buildUnderstand(input: ComposeInput, claims: readonly Claim[]): LabeledFact[] {
  // 6.4 camada 2: "Somente campos pertinentes a pergunta. Nao despejar todo o
  // cadastro." O filtro e o requiredFields do plano, mais lacunas explicitas.
  const relevant = new Set(input.plan.requiredFields);
  const facts: LabeledFact[] = [];
  for (const claim of claims) {
    const pertinent =
      relevant.has(claim.predicate) ||
      relevant.has('status') && claim.predicate === 'status' ||
      claim.state === 'divergent' ||
      claim.valueType === 'null';
    if (!pertinent && facts.length >= 6) continue;
    facts.push({
      label: labelFor(claim.predicate),
      value: claimValueText(claim),
      state: claim.state,
      evidenceIds: claim.evidenceIds,
      factDate: claim.factDate,
    });
  }
  for (const total of input.totals) {
    // 10.4: "Zero e um valor conhecido e nao deve substituir ausencia."
    // Uma etapa sem registro no recorte nao vale R$ 0,00; ela nao foi
    // localizada, e a frase precisa dizer isso.
    const empty = total.result.includedEventIds.length === 0;
    facts.push({
      label: FINANCIAL_STAGE_LABEL[total.stage],
      value: empty
        ? 'nenhum registro localizado nesta etapa dentro do recorte consultado'
        : `${formatMoney(total.result.net)} (${total.result.formula})`,
      state: empty ? 'not_located' : 'documented',
      evidenceIds: total.result.evidenceIds,
      factDate: total.result.latestFactDate,
    });
  }
  return facts;
}

export function compose(input: ComposeInput): { envelope: AnswerEnvelope; answerClaims: AnswerClaim[] } {
  const usable = input.claims.filter((c) => c.retiredAt === null);
  const answerClaims: AnswerClaim[] = usable.map((claim) => ({
    claimId: claim.id,
    text: buildClaimText(claim),
    evidenceIds: claim.evidenceIds,
    factDate: claim.factDate,
    state: claim.state,
  }));

  const evidenceIds = new Set<string>();
  for (const claim of usable) for (const id of claim.evidenceIds) evidenceIds.add(id);
  for (const total of input.totals) for (const id of total.result.evidenceIds) evidenceIds.add(id);

  const layers: AnswerLayers = {
    brief: buildBrief(input, usable),
    understand: buildUnderstand(input, usable),
    history: input.timeline,
    prove: [...evidenceIds],
  };

  const warnings: string[] = [];
  if (input.plan.periodIsDefault) {
    warnings.push(
      `Periodo padrao aplicado: ${input.plan.period.from} a ${input.plan.period.to}. Voce pode alterar o recorte.`,
    );
  }
  if (input.plan.requiredFields.includes('stage_disambiguation')) {
    warnings.push(
      'A pergunta usa um verbo que nao corresponde a uma etapa contabil. Os valores aparecem separados por etapa: indicado, empenhado, transferido e pago.',
    );
  }
  for (const total of input.totals) warnings.push(...total.result.warnings);
  if (input.containsSynthetic) {
    warnings.push('Este recorte contem registros sinteticos, identificados como tal e separados da base real.');
  }
  if (input.sourceCheckedAt === null) {
    warnings.push('Nenhuma coleta bem-sucedida registrada para as fontes deste assunto.');
  }

  const states = usable.map((c) => c.state);
  const status: AnswerEnvelope['status'] =
    usable.length === 0 && input.totals.every((t) => t.result.includedEventIds.length === 0)
      ? 'no_evidence'
      : input.gaps.length > 0 || states.includes('partial') || states.includes('not_located')
        ? 'partial'
        : 'complete';

  const envelope: AnswerEnvelope = {
    answerId: crypto.randomUUID(),
    context: {
      municipality: input.municipalityName,
      period: `${input.plan.period.from} a ${input.plan.period.to}`,
    },
    status,
    summary: layers.brief,
    claims: answerClaims,
    missingFields: input.gaps,
    warnings,
    conflicts: input.conflicts,
    layers,
    dataVersion: input.dataVersion,
    sourceCheckedAt: input.sourceCheckedAt as AnswerEnvelope['sourceCheckedAt'],
    evidenceReferenceAt: usable.reduce<PlainDate | null>(
      (latest, c) =>
        c.factDate !== null && (latest === null || daysBetween(latest, c.factDate) > 0) ? c.factDate : latest,
      null,
    ),
    researchJobId: null,
  };

  return { envelope, answerClaims };
}

/**
 * Texto de uma afirmacao. C.5: "Quando somente uma comunicacao relatar o fato,
 * atribua a informacao aquela fonte." O prefixo nao e enfeite: o validador
 * exige a atribuicao quando o estado e source_reported.
 */
export function buildClaimText(claim: Claim): string {
  const label = labelFor(claim.predicate);
  const value = claimValueText(claim);
  switch (claim.state) {
    case 'source_reported':
      return `A fonte informou: ${label.toLowerCase()} ${value}.`;
    case 'divergent':
      return `Ha uma divergencia sobre ${label.toLowerCase()}: ${value}.`;
    case 'not_located':
      return `${label}: nao localizado nas fontes consultadas.`;
    case 'stale_for_question':
      return `${label} no ultimo registro disponivel: ${value}.`;
    case 'partial':
      return `${label} (parcial): ${value}.`;
    default:
      return `${label}: ${value}.`;
  }
}

export { EVIDENCE_STATE_LABEL, worstState };
