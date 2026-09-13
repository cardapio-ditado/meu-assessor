/**
 * Planejador de consulta (15.2, C.4). Converte a pergunta em intencao e
 * filtros. Regras que o codigo garante, nao o prompt:
 *
 * - "Nao alterar permissoes a partir do conteudo da pergunta": o plano nunca
 *   contem tenant, classe de acesso ou papel. Esses campos vem do contexto.
 * - "Perguntas com ambiguidade material devem pedir um esclarecimento curto."
 * - O periodo padrao e visivel e alteravel; nunca silencioso (6.2).
 */
import {
  addDays,
  dateRange,
  todayIn,
  type DateRange,
  type PlainDate,
} from '../../domain/src/temporal.ts';
import type { FinancialStage } from '../../domain/src/states.ts';
import type { AuthorizedContext, EntityKind } from '../../domain/src/types.ts';
import { recognizeIdentifiers, type RecognizedIdentifier } from '../../retrieval/src/search.ts';

export const INTENTS = [
  'recent_changes',     // "o que mudou nos ultimos dez dias"
  'subject_status',     // "como esta a quadra do bairro X"
  'funding_lookup',     // "o que o parlamentar X mandou"
  'person_relations',
  'document_lookup',
  'meeting_prep',
  'total_amount',
  'unknown',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface QueryPlan {
  readonly intent: Intent;
  readonly rawQuestion: string;
  readonly identifiers: readonly RecognizedIdentifier[];
  readonly entityKinds: readonly EntityKind[];
  readonly period: DateRange;
  /** true quando o periodo foi escolhido pelo padrao e deve aparecer na tela. */
  readonly periodIsDefault: boolean;
  readonly financialStages: readonly FinancialStage[];
  readonly requiredFields: readonly string[];
  readonly needsCurrentState: boolean;
  readonly riskClass: 'low' | 'medium' | 'high';
  readonly clarificationNeeded: string | null;
  /** Ferramentas de leitura permitidas. O modelo nao amplia esta lista (C.4). */
  readonly allowedTools: readonly string[];
}

/** 7.3 / 6.3: janela padrao do feed de acontecimentos. */
export const DEFAULT_RECENT_DAYS = 10;
/** 6.2: periodo padrao visivel para consultas de recurso. */
export const DEFAULT_FUNDING_WINDOW_DAYS = 365 * 2;

const CURRENT_STATE_MARKERS = [
  'como esta', 'como está', 'esta agora', 'está agora', 'hoje', 'atual', 'atualmente',
  'terminou', 'concluida', 'concluída', 'ja entrou', 'já entrou', 'situacao', 'situação',
  'andamento', 'em obras', 'funcionando',
];

const TOTAL_MARKERS = ['quanto', 'total', 'soma', 'valor total', 'quantos reais'];
const FUNDING_MARKERS = ['emenda', 'emendas', 'mandou', 'destinou', 'repasse', 'recurso', 'recursos', 'convenio', 'convênio', 'transferencia', 'transferência'];
const CHANGE_MARKERS = ['o que mudou', 'mudou', 'novidade', 'novidades', 'ultimos dias', 'últimos dias', 'recente', 'recentes'];
const MEETING_MARKERS = ['reuniao', 'reunião', 'entrevista', 'preparar', 'preparacao', 'preparação', 'briefing'];
const PERSON_MARKERS = ['deputado', 'deputada', 'senador', 'senadora', 'vereador', 'vereadora', 'parlamentar', 'secretario', 'secretária', 'secretario', 'prefeito', 'prefeita'];
const DOCUMENT_MARKERS = ['contrato', 'aditivo', 'edital', 'licitacao', 'licitação', 'decreto', 'portaria', 'ata', 'publicacao', 'publicação', 'diario', 'diário'];

function has(text: string, markers: readonly string[]): boolean {
  return markers.some((m) => text.includes(m));
}

function detectIntent(lower: string): Intent {
  if (has(lower, CHANGE_MARKERS)) return 'recent_changes';
  if (has(lower, MEETING_MARKERS)) return 'meeting_prep';
  if (has(lower, TOTAL_MARKERS) && has(lower, FUNDING_MARKERS)) return 'total_amount';
  if (has(lower, FUNDING_MARKERS) && has(lower, PERSON_MARKERS)) return 'funding_lookup';
  if (has(lower, FUNDING_MARKERS)) return 'funding_lookup';
  if (has(lower, PERSON_MARKERS)) return 'person_relations';
  if (has(lower, DOCUMENT_MARKERS)) return 'document_lookup';
  if (has(lower, CURRENT_STATE_MARKERS)) return 'subject_status';
  return 'unknown';
}

function periodFor(intent: Intent, today: PlainDate): { period: DateRange; isDefault: boolean } {
  switch (intent) {
    case 'recent_changes':
      return { period: dateRange(addDays(today, -DEFAULT_RECENT_DAYS), today), isDefault: true };
    case 'funding_lookup':
    case 'total_amount':
    case 'person_relations':
      return { period: dateRange(addDays(today, -DEFAULT_FUNDING_WINDOW_DAYS), today), isDefault: true };
    default:
      return { period: dateRange(addDays(today, -365 * 10), today), isDefault: true };
  }
}

function entityKindsFor(intent: Intent): EntityKind[] {
  switch (intent) {
    case 'funding_lookup':
    case 'total_amount':
      return ['amendment', 'transfer_instrument', 'subject', 'organ'];
    case 'person_relations':
      return ['public_person'];
    case 'document_lookup':
      return ['contract', 'procurement', 'amendment'];
    case 'subject_status':
      return ['subject', 'contract'];
    case 'meeting_prep':
      return ['subject', 'public_person', 'contract', 'amendment'];
    default:
      return ['subject', 'contract', 'amendment', 'public_person', 'organ', 'transfer_instrument'];
  }
}

function requiredFieldsFor(intent: Intent): string[] {
  switch (intent) {
    case 'subject_status':
      return ['status', 'status_reference_date', 'responsible_organ'];
    case 'funding_lookup':
    case 'total_amount':
      return ['authorship', 'financial_stage', 'amount', 'beneficiary', 'period'];
    case 'person_relations':
      return ['authorship', 'relation_type', 'role_at_date'];
    case 'document_lookup':
      return ['document_number', 'publication_date', 'validity'];
    case 'recent_changes':
      return ['fact_date', 'publication_date'];
    case 'meeting_prep':
      return ['status', 'timeline', 'amount', 'gaps'];
    default:
      return ['status'];
  }
}

const TOOLS_BY_INTENT: Record<Intent, readonly string[]> = {
  recent_changes: ['search_documents', 'list_recent_claims'],
  subject_status: ['search_entities', 'get_claims', 'get_evidence', 'get_timeline'],
  funding_lookup: ['search_entities', 'get_financial_events', 'compute_total', 'get_person_relations', 'get_evidence'],
  person_relations: ['search_entities', 'get_person_relations', 'get_evidence'],
  document_lookup: ['search_documents', 'get_evidence'],
  meeting_prep: ['search_entities', 'get_claims', 'get_timeline', 'get_financial_events', 'compute_total', 'get_gaps'],
  total_amount: ['search_entities', 'get_financial_events', 'compute_total', 'get_evidence'],
  unknown: ['search_entities', 'search_documents'],
};

/**
 * "Mandou" nao e um campo contabil (6.2). Perguntas assim exigem separar
 * autoria, instrumento e execucao; o plano registra isso como ressalva
 * obrigatoria e nao como esclarecimento bloqueante.
 */
const VAGUE_VERBS = ['mandou', 'trouxe', 'conseguiu', 'garantiu', 'liberou'];

export function planQuestion(question: string, context: AuthorizedContext): QueryPlan {
  const trimmed = question.trim();
  const lower = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const intent = detectIntent(lower);
  const today = todayIn(context.timeZone);
  const { period, isDefault } = periodFor(intent, today);
  const identifiers = recognizeIdentifiers(trimmed);

  let clarificationNeeded: string | null = null;
  if (trimmed.length < 3) {
    clarificationNeeded = 'A pergunta ficou curta. O que voce precisa saber?';
  } else if (intent === 'unknown' && identifiers.length === 0 && trimmed.split(/\s+/).length <= 2) {
    clarificationNeeded = `Voce quer a situacao de um assunto, um documento ou recursos? Diga com um pouco mais de detalhe.`;
  }

  const needsCurrentState = has(lower, CURRENT_STATE_MARKERS);
  const usesVagueVerb = has(lower, VAGUE_VERBS);

  const riskClass: QueryPlan['riskClass'] =
    intent === 'total_amount' || intent === 'funding_lookup' || intent === 'person_relations'
      ? 'high'
      : needsCurrentState
        ? 'medium'
        : 'low';

  const requiredFields = requiredFieldsFor(intent);

  return {
    intent,
    rawQuestion: trimmed,
    identifiers,
    entityKinds: entityKindsFor(intent),
    period,
    periodIsDefault: isDefault,
    financialStages:
      intent === 'funding_lookup' || intent === 'total_amount'
        ? (['indicated', 'committed', 'transferred', 'paid_supplier'] as const)
        : [],
    requiredFields: usesVagueVerb ? [...requiredFields, 'stage_disambiguation'] : requiredFields,
    needsCurrentState,
    riskClass,
    clarificationNeeded,
    allowedTools: TOOLS_BY_INTENT[intent],
  };
}
