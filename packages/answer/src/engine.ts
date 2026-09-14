/**
 * Caminho de consulta completo (B.3). A ordem das etapas aqui e a do
 * pseudocodigo do briefing, e cada etapa e uma funcao separada para que os
 * testes possam falhar em um ponto especifico.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  interpretQuestion,
  synthesizeDocumentAnswer,
  type DocumentSynthesis,
} from '../../ai/src/gemini.ts';
import type { QueryRunner } from '../../db/src/pool.ts';
import { accessSignature } from '../../db/src/auth.ts';
import {
  getClaims,
  getConflicts,
  getDocumentMunicipalities,
  getEntity,
  getEvidence,
  getFinancialEvents,
  getGaps,
  getLastSuccessfulCollection,
  getRelationTypesBySubject,
  getTimeline,
} from '../../db/src/repository.ts';
import {
  resolveOne,
  searchDocuments,
  searchEntities,
  type DocumentHit,
  type EntityCandidate,
} from '../../retrieval/src/search.ts';
import { computeTotal, type TotalResult } from '../../finance/src/totals.ts';
import { deduplicate } from '../../finance/src/dedup.ts';
import { todayIn } from '../../domain/src/temporal.ts';
import type { FinancialStage } from '../../domain/src/states.ts';
import type { AnswerEnvelope, AuthorizedContext, Claim } from '../../domain/src/types.ts';
import type { Money } from '../../domain/src/money.ts';
import { compose } from './compose.ts';
import { planQuestion, type QueryPlan } from './planner.ts';
import { validateAnswer, type ValidationResult } from './validator.ts';

export const PROMPT_VERSION = 'prompts/v2-executive-documents';

export interface AskResult {
  readonly envelope: AnswerEnvelope;
  readonly plan: QueryPlan;
  readonly validation: ValidationResult;
  readonly candidates: readonly EntityCandidate[];
  readonly cacheKey: string;
  readonly latencyMs: number;
}

/** 16.3: a chave carrega organizacao, acesso, consulta, periodo e versoes. */
export function cacheKeyFor(
  context: AuthorizedContext,
  plan: QueryPlan,
  resolvedEntityId: string | null,
  dataVersion: string,
): string {
  const material = [
    accessSignature(context),
    plan.intent,
    plan.rawQuestion.toLowerCase().replace(/\s+/g, ' ').trim(),
    resolvedEntityId ?? '-',
    `${plan.period.from}..${plan.period.to}`,
    plan.financialStages.join(','),
    dataVersion,
    PROMPT_VERSION,
  ].join(' ');
  return createHash('sha256').update(material).digest('hex');
}

/** Versao do conjunto de dados consultado (13.5). */
export async function currentDataVersion(db: QueryRunner): Promise<string> {
  const r = await db.query<{ v: string }>(
    `select coalesce(md5(string_agg(x.sig, '|' order by x.sig)), 'empty') as v
       from (
         select coalesce(max(recorded_at)::text, '-') || ':' || count(*)::text as sig from ma.claims
         union all
         select coalesce(max(collected_at)::text, '-') || ':' || count(*)::text from ma.document_versions
         union all
         select coalesce(max(created_at)::text, '-') || ':' || count(*)::text from ma.financial_events
       ) x`,
  );
  return r.rows[0]?.v ?? 'empty';
}


function documentMatches(
  plan: QueryPlan,
  municipality: string,
  hits: readonly DocumentHit[],
  dataVersion: string,
  sourceCheckedAt: string | null,
  synthesis: DocumentSynthesis,
): AnswerEnvelope {
  const evidenceIds = [...new Set(hits.flatMap((hit) => hit.evidenceIds))];
  const dated = hits
    .map((hit) => hit.publicationDate)
    .filter((date): date is NonNullable<DocumentHit['publicationDate']> => date !== null)
    .sort();
  const hitByIndex = new Map(hits.map((hit, index) => [index + 1, hit] as const));

  const understand = synthesis.items.flatMap((item) => {
    const hit = hitByIndex.get(item.documentIndex);
    if (hit === undefined) return [];
    const attention =
      item.attention === null ? '' : ` Ponto de atenção: ${item.attention}`;
    return [{
      label: `${hit.sourceCode} · ${item.headline}`,
      value: `${item.explanation}${attention}`,
      state: 'documented' as const,
      evidenceIds: hit.evidenceIds,
      factDate: hit.publicationDate,
    }];
  });

  const warnings = [
    ...synthesis.limitations,
    'Resposta elaborada a partir dos documentos localizados. Confira os atos originais em "Comprove".',
  ];
  if (synthesis.provider === 'deterministic') {
    warnings.push('A síntese automática ficou indisponível; a apresentação foi reduzida.');
  }

  return {
    answerId: randomUUID(),
    context: {
      municipality,
      period: `${plan.period.from} a ${plan.period.to}`,
    },
    status: 'partial',
    summary: synthesis.summary,
    claims: [],
    missingFields: [],
    warnings,
    conflicts: [],
    layers: {
      brief: synthesis.summary,
      understand,
      history: [],
      prove: evidenceIds,
    },
    dataVersion,
    sourceCheckedAt: sourceCheckedAt as AnswerEnvelope['sourceCheckedAt'],
    evidenceReferenceAt: dated.at(-1) ?? null,
    researchJobId: null,
  };
}

function emptyValidation(): ValidationResult {
  return { verdict: 'passed', assessments: [], keptClaims: [], removedClaims: [], technicalReasons: [] };
}

export async function ask(
  db: QueryRunner,
  context: AuthorizedContext,
  question: string,
): Promise<AskResult> {
  const startedAt = performance.now();
  const plan = planQuestion(question, context);
  const interpretation = await interpretQuestion(question);
  const today = todayIn(context.timeZone);
  const dataVersion = await currentDataVersion(db);
  const periodText = `${plan.period.from} a ${plan.period.to}`;

  // Ambiguidade material da propria pergunta: esclarecimento curto (15.2).
  if (plan.clarificationNeeded !== null) {
    return finish(
      clarification(plan.clarificationNeeded, context.municipalityName, periodText, dataVersion),
      plan,
      emptyValidation(),
      [],
      cacheKeyFor(context, plan, null, dataVersion),
      startedAt,
    );
  }

  const candidates = await searchEntities(db, context, interpretation.searchQuery, { kinds: plan.entityKinds });
  const resolution = resolveOne(candidates);

  // T02 / 6.1: nao escolher silenciosamente a primeira entre candidatos.
  // O resumo carrega APENAS a pergunta curta (6.1: "escolhas curtas"). As
  // opcoes viajam em `candidates`, para que cada cliente as apresente como
  // escolha selecionavel em vez de um paragrafo corrido.
  if (resolution.kind === 'ambiguous') {
    const text = 'Encontrei mais de uma possibilidade no recorte consultado.';
    return finish(
      clarification(text, context.municipalityName, periodText, dataVersion),
      plan,
      emptyValidation(),
      resolution.options,
      cacheKeyFor(context, plan, null, dataVersion),
      startedAt,
    );
  }

  // Perguntas amplas ("quais contratos existem?", "o que saiu no diario?")
  // frequentemente nao nomeiam uma entidade. Antes, o motor encerrava aqui e
  // ignorava a busca documental que ja existia. Agora o acervo e consultado e
  // devolvido como lista rastreavel, sem inventar uma sintese factual.
  if (resolution.kind === 'not_found') {
    const hits = await searchDocuments(db, interpretation.searchQuery, { period: plan.period, limit: 10 });
    if (hits.length > 0) {
      const sourceCheckedAt = await getLastSuccessfulCollection(db);
      const synthesis = await synthesizeDocumentAnswer(
        question,
        hits.map((hit, index) => ({
          documentIndex: index + 1,
          sourceCode: hit.sourceCode,
          title: hit.title,
          publicationDate: hit.publicationDate,
          snippet: hit.snippet,
        })),
      );
      return finish(
        documentMatches(
          plan,
          context.municipalityName,
          hits,
          dataVersion,
          sourceCheckedAt,
          synthesis,
        ),
        plan,
        emptyValidation(),
        candidates,
        cacheKeyFor(context, plan, null, dataVersion),
        startedAt,
      );
    }
  }

  const subject = resolution.entity === null ? null : await getEntity(db, resolution.entity.id);
  const claims: Claim[] = subject === null ? [] : await getClaims(db, subject.id);
  const timeline = subject === null ? [] : await getTimeline(db, subject.id);
  const gaps = subject === null ? [] : await getGaps(db, subject.id);
  const conflicts = subject === null ? [] : await getConflicts(db, subject.id);
  const sourceCheckedAt = await getLastSuccessfulCollection(db);

  // Totais deterministicos por etapa, com deduplicacao antes da soma (11.4).
  const totals: { stage: FinancialStage; result: TotalResult }[] = [];
  if (subject !== null && plan.financialStages.length > 0) {
    const isInstrument = subject.kind === 'amendment' || subject.kind === 'transfer_instrument';
    const subjectFilter = subject.kind === 'subject' ? subject.id : null;
    const instrumentFilter = isInstrument ? subject.id : null;
    const raw = await getFinancialEvents(db, {
      subjectId: subjectFilter,
      payeeEntityId: null,
      instrumentId: instrumentFilter,
      stages: plan.financialStages,
      period: plan.period,
    });
    const { kept } = deduplicate(raw);
    for (const stage of plan.financialStages) {
      totals.push({
        stage,
        result: computeTotal(kept, {
          stage,
          period: plan.period,
          beneficiaryEntityId: null,
          subjectId: subjectFilter,
          instrumentId: instrumentFilter,
          budgetYear: null,
          currency: 'BRL',
          applyCancellations: true,
        }),
      });
    }
  }

  const containsSynthetic = await hasSyntheticEvidence(db, claims.map((c) => c.id));

  const { envelope, answerClaims } = compose({
    plan,
    subject,
    claims,
    timeline,
    totals,
    gaps,
    conflicts,
    municipalityName: context.municipalityName,
    today,
    dataVersion,
    sourceCheckedAt,
    containsSynthetic,
  });

  // Validacao antes de apresentar (15.5). Nada passa por confianca do modelo.
  const evidenceIds = [...new Set(answerClaims.flatMap((c) => c.evidenceIds))];
  const evidenceMap = await getEvidence(db, evidenceIds);
  const documentIds = [...new Set([...evidenceMap.values()].map((e) => e.documentVersionId))];
  const documentMunicipality = await getDocumentMunicipalities(db, documentIds);
  const relationTypes = await getRelationTypesBySubject(db, subject === null ? [] : [subject.id]);

  const computedAmounts = new Map<string, Money>();
  for (const claim of claims) {
    if (claim.money !== null) computedAmounts.set(claim.id, claim.money);
  }

  const validation = validateAnswer({
    retrievedEvidence: evidenceMap,
    retrievedClaims: new Map(claims.map((c) => [c.id, c])),
    answerClaims,
    contextMunicipalityId: context.municipalityId,
    documentMunicipality,
    today,
    needsCurrentState: plan.needsCurrentState,
    personRelations: relationTypes,
    computedAmounts,
  });

  // 15.5: quando a verificacao falha, reduzir ao que e sustentado ou abster-se.
  const finalEnvelope: AnswerEnvelope =
    validation.verdict === 'passed'
      ? envelope
      : {
          ...envelope,
          status: validation.keptClaims.length === 0 ? 'no_evidence' : 'partial',
          claims: validation.keptClaims,
          layers: {
            ...envelope.layers,
            understand: envelope.layers.understand.filter((f) =>
              f.evidenceIds.some((id) => evidenceMap.has(id)),
            ),
          },
          summary:
            validation.keptClaims.length === 0
              ? `Nao consegui sustentar uma resposta com as evidencias disponiveis sobre ${subject?.officialName ?? 'o assunto consultado'}. ` +
                `${validation.removedClaims.length} afirmacao(oes) foram bloqueadas na verificacao.`
              : envelope.summary,
          warnings: [
            ...envelope.warnings,
            `${validation.removedClaims.length} afirmacao(oes) removida(s) por falta de suporte na verificacao.`,
          ],
        };

  return finish(
    finalEnvelope,
    plan,
    validation,
    candidates,
    cacheKeyFor(context, plan, subject?.id ?? null, dataVersion),
    startedAt,
  );
}

async function hasSyntheticEvidence(db: QueryRunner, claimIds: readonly string[]): Promise<boolean> {
  if (claimIds.length === 0) return false;
  const r = await db.query<{ any_synthetic: boolean }>(
    `select coalesce(bool_or(d.is_synthetic), false) as any_synthetic
       from ma.document_versions d
       join ma.evidence e on e.document_version_id = d.id
       join ma.claim_evidence ce on ce.evidence_id = e.id
      where ce.claim_id = any($1::uuid[])`,
    [claimIds],
  );
  return r.rows[0]?.any_synthetic === true;
}

function clarification(
  text: string,
  municipality: string,
  period: string,
  dataVersion: string,
): AnswerEnvelope {
  return {
    answerId: randomUUID(),
    context: { municipality, period },
    status: 'clarification_needed',
    summary: text,
    claims: [],
    missingFields: [],
    warnings: [],
    conflicts: [],
    layers: { brief: text, understand: [], history: [], prove: [] },
    dataVersion,
    sourceCheckedAt: null,
    evidenceReferenceAt: null,
    researchJobId: null,
  };
}

function finish(
  envelope: AnswerEnvelope,
  plan: QueryPlan,
  validation: ValidationResult,
  candidates: readonly EntityCandidate[],
  cacheKey: string,
  startedAt: number,
): AskResult {
  return {
    envelope,
    plan,
    validation,
    candidates,
    cacheKey,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

/** Persiste a trilha da resposta (12.5). */
export async function recordAnswer(
  db: QueryRunner,
  context: AuthorizedContext,
  result: AskResult,
): Promise<void> {
  await db.query(
    `insert into ma.answers
       (tenant_id, user_id, question_text, question_normalized, plan, status, summary,
        envelope, claim_ids, evidence_ids, data_version, prompt_version, model_id,
        validator_verdict, validator_detail, latency_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      context.tenantId,
      context.userId,
      result.plan.rawQuestion,
      result.plan.rawQuestion.toLowerCase().replace(/\s+/g, ' ').trim(),
      JSON.stringify(result.plan),
      result.envelope.status,
      result.envelope.summary,
      JSON.stringify(result.envelope),
      result.envelope.claims.map((c) => c.claimId),
      result.envelope.layers.prove,
      result.envelope.dataVersion,
      PROMPT_VERSION,
      null,
      result.validation.verdict,
      JSON.stringify({
        assessments: result.validation.assessments,
        technicalReasons: result.validation.technicalReasons,
      }),
      result.latencyMs,
    ],
  );
}
