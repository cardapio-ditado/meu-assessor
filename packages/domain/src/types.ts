/**
 * Entidades minimas do Anexo A. Tipos sao contrato: o que nao esta aqui nao
 * pode ser inventado por um modelo mais adiante no fluxo.
 */
import type { Money } from './money.ts';
import type { Instant, PlainDate, ValidityInterval } from './temporal.ts';
import type {
  AccessClass,
  EvidenceState,
  FinancialStage,
  FreshnessClass,
  RelationType,
  ValidationState,
} from './states.ts';

/** Contexto autorizado. Derivado da sessao no servidor, nunca do cliente (B.2). */
export interface AuthorizedContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly municipalityId: string;
  readonly municipalityName: string;
  readonly timeZone: string;
  readonly roles: readonly Role[];
  /** Classes de acesso que esta sessao pode ler. */
  readonly accessClasses: readonly AccessClass[];
}

export const ROLES = [
  'manager',
  'cabinet',
  'data_curator',
  'technical_validator',
  'municipal_admin',
  'platform_ops',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export interface SourceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;              // F01..F24 ou codigo interno
  readonly officialName: string;
  readonly domain: string;
  readonly organ: string;
  readonly sphere: 'municipal' | 'state' | 'federal' | 'association' | 'other';
  readonly recordTypes: readonly string[];
  readonly accessMethod: 'api' | 'structured_export' | 'html' | 'document' | 'manual';
  readonly requiresCredentials: boolean;
  /** Periodo efetivamente disponivel, nao o desejado. */
  readonly availableFrom: PlainDate | null;
  readonly availableTo: PlainDate | null;
  readonly desiredFrequency: string;
  readonly lastAttemptAt: Instant | null;
  readonly lastSuccessAt: Instant | null;
  readonly providerUpdatedAt: Instant | null;
  readonly connectorVersion: string;
  readonly accessClass: AccessClass;
  readonly operationalOwner: string;
  readonly knownLimitations: readonly string[];
}

export interface DocumentVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly externalId: string | null;
  readonly documentType: string | null;
  readonly titleOriginal: string;
  readonly titleNormalized: string;
  readonly issuingOrgan: string | null;
  readonly numberOriginal: string | null;
  readonly fiscalYear: number | null;
  readonly urlOriginal: string | null;
  readonly urlFinal: string | null;
  readonly publicationDate: PlainDate | null;
  readonly signatureDate: PlainDate | null;
  readonly referenceDate: PlainDate | null;
  readonly collectedAt: Instant;
  readonly objectKey: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly contentHash: string;        // integridade da copia, nao autenticidade
  readonly extractionMethod: 'native_text' | 'structured' | 'html' | 'ocr' | 'manual';
  readonly parserVersion: string;
  readonly textContent: string | null;
  readonly extractionQuality: 'high' | 'uncertain' | 'requires_review';
  readonly accessClass: AccessClass;
  readonly recordVersion: number;
  readonly supersedesId: string | null;
  readonly isSynthetic: boolean;       // 1.2: dado ficticio sempre identificado
}

/** Trecho que sustenta uma afirmacao (A.3). Sem isto nao existe afirmacao. */
export interface Evidence {
  readonly id: string;
  readonly tenantId: string;
  readonly documentVersionId: string;
  readonly locator: string;            // pagina, secao ou caminho do campo
  readonly snippet: string;            // suficiente para conferir contexto e negacao
  readonly queryParameters: Readonly<Record<string, string>> | null; // sem credenciais
  readonly obtainedAt: Instant;
  readonly accessClass: AccessClass;
}

export interface Claim {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly subjectKind: EntityKind;
  readonly predicate: string;
  readonly value: string | number | boolean | null;
  readonly valueType: 'text' | 'integer' | 'decimal' | 'date' | 'boolean' | 'money' | 'null';
  readonly money: Money | null;
  readonly unit: string | null;
  readonly qualifiers: Readonly<Record<string, string>>;
  readonly validFrom: PlainDate | null;
  readonly validTo: PlainDate | null;
  readonly factDate: PlainDate | null;
  readonly recordedAt: Instant;
  readonly retiredAt: Instant | null;
  readonly evidenceIds: readonly string[];
  readonly state: EvidenceState;
  readonly validationState: ValidationState;
  readonly freshnessClass: FreshnessClass;
  readonly nullReason: string | null;   // 10.4: null com motivo
  readonly reviewedBy: string | null;
  readonly reviewMethod: string | null;
  readonly accessClass: AccessClass;
}

export const ENTITY_KINDS = [
  'organ',
  'public_person',
  'locality',
  'subject',         // assunto / acao / obra
  'procurement',
  'contract',
  'amendment',       // emenda
  'transfer_instrument',
  'news_item',
  'official_publication',  // edicao de diario oficial: publica, mas nao e noticia
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface Entity {
  readonly id: string;
  readonly tenantId: string;
  readonly municipalityId: string;
  readonly kind: EntityKind;
  readonly officialName: string;
  readonly aliases: readonly string[];
  readonly externalIds: Readonly<Record<string, string>>;
  readonly localityId: string | null;
  readonly areaId: string | null;
  readonly accessClass: AccessClass;
}

export interface FinancialEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly payerEntityId: string | null;
  readonly payeeEntityId: string | null;
  readonly instrumentId: string | null;
  readonly subjectId: string | null;
  readonly financialDocument: string | null;
  readonly cancelsEventId: string | null;
  readonly stage: FinancialStage;
  readonly factDate: PlainDate | null;
  readonly budgetYear: number | null;
  readonly amendmentYear: number | null;
  readonly amount: Money;
  /** 11.4: fluxo soma; posicao acumulada nao soma. */
  readonly measure: 'flow' | 'cumulative_position';
  readonly linkConfirmed: boolean;
  readonly reconciliationState: 'unreconciled' | 'reconciled' | 'duplicate_of';
  readonly duplicateOfId: string | null;
  readonly evidenceIds: readonly string[];
  readonly accessClass: AccessClass;
  readonly isSynthetic: boolean;
}

export interface PublicPersonRelation {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly relatedEntityId: string;
  readonly relationType: RelationType;
  readonly roleAtDate: string | null;
  readonly validity: ValidityInterval;
  readonly sphere: 'municipal' | 'state' | 'federal' | null;
  readonly documentedShare: Money | null;
  readonly evidenceIds: readonly string[];
  readonly matchMethod: 'official_id' | 'curated_alias' | 'textual_similarity' | 'manual';
  readonly validationState: ValidationState;
  readonly accessClass: AccessClass;
}

/** A.6 - Contrato de saida da resposta. */
export interface AnswerClaim {
  readonly claimId: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly factDate: PlainDate | null;
  readonly state: EvidenceState;
}

export interface AnswerEnvelope {
  readonly answerId: string;
  readonly context: {
    readonly municipality: string;
    readonly period: string;
  };
  readonly status: 'complete' | 'partial' | 'clarification_needed' | 'no_evidence' | 'unavailable';
  readonly summary: string;
  readonly claims: readonly AnswerClaim[];
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
  readonly layers: AnswerLayers;
  readonly dataVersion: string;
  readonly sourceCheckedAt: Instant | null;
  readonly evidenceReferenceAt: PlainDate | null;
  readonly researchJobId: string | null;
}

/** 6.4 - As quatro camadas apontam para o MESMO conjunto de evidencias. */
export interface AnswerLayers {
  readonly brief: string;                       // 1. em poucos segundos
  readonly understand: readonly LabeledFact[];  // 2. entenda
  readonly history: readonly TimelineItem[];    // 3. historico e relacoes
  readonly prove: readonly string[];            // 4. comprove (evidence ids)
}

export interface LabeledFact {
  readonly label: string;
  readonly value: string;
  readonly state: EvidenceState;
  readonly evidenceIds: readonly string[];
  readonly factDate: PlainDate | null;
}

export interface TimelineItem {
  readonly factDate: PlainDate | null;
  readonly publicationDate: PlainDate | null;
  readonly title: string;
  readonly relationNature: string;
  readonly evidenceIds: readonly string[];
}
