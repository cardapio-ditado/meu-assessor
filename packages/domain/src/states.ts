/**
 * Enumeracoes de estado do produto. Briefing 6.5, 12.4, 11.1, A.1.
 * Os rotulos em portugues sao os textos que o gestor le; os codigos sao
 * estaveis para banco, cache e testes.
 */

/** 6.5 - Estados de resposta, que podem coexistir por campo. */
export const EVIDENCE_STATES = [
  'documented',        // evidencia suficiente para o fato e o recorte
  'source_reported',   // uma comunicacao relata algo ainda nao confirmado
  'partial',           // parte da pergunta foi respondida
  'divergent',         // conflito material nao resolvido
  'not_located',       // consulta nao encontrou suporte suficiente
  'stale_for_question',// existe registro, mas nao permite afirmar o estado atual
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const EVIDENCE_STATE_LABEL: Record<EvidenceState, string> = {
  documented: 'Documentado',
  source_reported: 'Informado pela fonte',
  partial: 'Parcial',
  divergent: 'Divergente',
  not_located: 'Sem evidencia localizada',
  stale_for_question: 'Desatualizado para esta pergunta',
};

/** 12.4 - Maquina de estados de publicacao, separada da vigencia do fato. */
export const VALIDATION_STATES = [
  'received',
  'extracted',
  'candidate',
  'auto_validated',
  'human_reviewed',
  'published',
  'in_conflict',
  'stale',
  'superseded',
  'withdrawn',
] as const;
export type ValidationState = (typeof VALIDATION_STATES)[number];

/** Estados a partir dos quais uma afirmacao pode sustentar uma resposta. */
export const ANSWERABLE_VALIDATION_STATES: readonly ValidationState[] = [
  'auto_validated',
  'human_reviewed',
  'published',
];

/** Campos de alto risco (12.4): exigem validacao mais forte. */
export const HIGH_RISK_PREDICATES = [
  'identity',
  'authorship',
  'amount',
  'financial_stage',
  'imputation',
] as const;
export type HighRiskPredicate = (typeof HIGH_RISK_PREDICATES)[number];

/** 11.1 - Etapas financeiras, deliberadamente nao somaveis entre si. */
export const FINANCIAL_STAGES = [
  'announced',    // declaracao em comunicacao; nao contabilizar
  'indicated',    // indicado / previsto / autorizado
  'committed',    // empenhado
  'liquidated',   // liquidado
  'transferred',  // transferido / desembolsado pelo concedente
  'received',     // ingresso demonstrado no ente destinatario
  'paid_supplier',// pago ao fornecedor pelo executor
  'cancelled',    // anulado / estornado / devolvido
] as const;
export type FinancialStage = (typeof FINANCIAL_STAGES)[number];

export const FINANCIAL_STAGE_LABEL: Record<FinancialStage, string> = {
  announced: 'Anunciado',
  indicated: 'Indicado / previsto / autorizado',
  committed: 'Empenhado',
  liquidated: 'Liquidado',
  transferred: 'Transferido',
  received: 'Recebido',
  paid_supplier: 'Pago ao fornecedor',
  cancelled: 'Anulado / devolvido',
};

/** Etapas que a fonte declara mas que nao demonstram dinheiro movimentado. */
export const NON_FINANCIAL_STAGES: readonly FinancialStage[] = ['announced', 'indicated'];

/** A.1 - Classe de acesso do registro. */
export const ACCESS_CLASSES = ['public', 'internal_authorized', 'restricted', 'blocked'] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

/** 14.3 - Classes de frescor, que definem como a ultima evidencia e usada. */
export const FRESHNESS_CLASSES = ['stable_history', 'mutable_operational', 'critical', 'undefined'] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

/** Limiar em dias a partir do qual a evidencia deixa de sustentar "hoje". */
export const FRESHNESS_MAX_AGE_DAYS: Record<FreshnessClass, number | null> = {
  stable_history: null,          // sem limite; revalidar links periodicamente
  mutable_operational: 30,
  critical: 2,
  undefined: 0,                  // nunca apresentar como atual
};

/** 11.2 - Tipos de vinculo de agente publico, que nunca se convertem entre si. */
export const RELATION_TYPES = [
  'author',              // autoria comprovada de emenda
  'coauthor',
  'collective_bench',    // bancada ou comissao
  'instrument_proposer',
  'grantor',             // concedente
  'paying_unit',
  'beneficiary',
  'executor',
  'contractor',
  'signatory_as_rep',
  'rapporteur',
  'mentioned_by_source', // participacao mencionada em comunicacao
  'unproven_link',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Vinculos que NAO autorizam afirmar autoria ou destinacao de recurso. */
export const NON_AUTHORSHIP_RELATIONS: readonly RelationType[] = [
  'mentioned_by_source',
  'unproven_link',
  'signatory_as_rep',
  'rapporteur',
];

/** Rotulos de tipo de entidade para a tela. 7.1: nada essencial so por icone. */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  organ: 'orgao',
  public_person: 'agente publico',
  locality: 'localidade',
  subject: 'obra ou acao',
  procurement: 'licitacao',
  contract: 'contrato',
  amendment: 'emenda',
  transfer_instrument: 'instrumento de transferencia',
  news_item: 'noticia',
  official_publication: 'publicacao oficial',
};
