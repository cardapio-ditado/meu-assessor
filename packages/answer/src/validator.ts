/**
 * Validador de resposta (15.5, C.6). Roda DEPOIS da redacao e ANTES de
 * apresentar. Nao e um aviso generico: quando uma afirmacao nao passa, ela e
 * removida ou a resposta se abstem.
 *
 * "Nunca manter uma conclusao e apenas adicionar um aviso generico de que 'IA
 * pode errar'." (15.5)
 *
 * Checagens implementadas aqui:
 *  - cada referencia EXISTE no conjunto recuperado desta consulta (T35)
 *  - a referencia SUSTENTA a frase, nao apenas existe (T36)
 *  - valores citados batem com os campos estruturados (T29, T19)
 *  - data do fato compativel com o recorte e com o frescor (T22, T26)
 *  - autoria so aparece com relacao tipada de autoria (T09)
 *  - municipio da evidencia e o municipio do contexto (T32, T33)
 */
import { daysBetween, type PlainDate } from '../../domain/src/temporal.ts';
import {
  ANSWERABLE_VALIDATION_STATES,
  FRESHNESS_MAX_AGE_DAYS,
  NON_AUTHORSHIP_RELATIONS,
  type RelationType,
} from '../../domain/src/states.ts';
import { formatMoney, type Money } from '../../domain/src/money.ts';
import type { AnswerClaim, Claim, Evidence } from '../../domain/src/types.ts';

export type ClaimVerdict = 'supported' | 'supported_with_caveat' | 'unsupported' | 'contradicted';

export interface ClaimAssessment {
  readonly claimId: string;
  readonly verdict: ClaimVerdict;
  readonly reasons: readonly string[];
}

export interface ValidationInput {
  /** Conjunto RECUPERADO nesta consulta. Nada fora dele pode ser citado. */
  readonly retrievedEvidence: ReadonlyMap<string, Evidence>;
  readonly retrievedClaims: ReadonlyMap<string, Claim>;
  readonly answerClaims: readonly AnswerClaim[];
  readonly contextMunicipalityId: string;
  /** Municipio de cada documento citado, resolvido no servidor. */
  readonly documentMunicipality: ReadonlyMap<string, string>;
  readonly today: PlainDate;
  readonly needsCurrentState: boolean;
  /** Relacoes tipadas disponiveis, por id de entidade citada. */
  readonly personRelations: ReadonlyMap<string, readonly RelationType[]>;
  /** Valores calculados deterministicamente, para conferir os numeros do texto. */
  readonly computedAmounts: ReadonlyMap<string, Money>;
}

export interface ValidationResult {
  readonly verdict: 'passed' | 'reduced' | 'abstained' | 'blocked';
  readonly assessments: readonly ClaimAssessment[];
  readonly keptClaims: readonly AnswerClaim[];
  readonly removedClaims: readonly AnswerClaim[];
  readonly technicalReasons: readonly string[];
}

/** Palavras que afirmam estado presente e exigem evidencia compativel. */
const PRESENT_STATE_WORDS = /\b(esta|est[aá]|foi conclu[ií]d[ao]|conclu[ií]d[ao]|terminou|finalizad[ao]|em andamento|funcionando|entregue)\b/i;
/** Palavras de autoria, que exigem relacao tipada de autoria. */
const AUTHORSHIP_WORDS = /\b(autor|autoria|de autoria|destinou|enviou|mandou)\b/i;
/** T24: a base nao prova inexistencia; estas formas sao proibidas. */
const DENIES_EXISTENCE = /\b(n[aã]o existe|inexistente|nunca (houve|existiu)|n[aã]o h[aá] (essa|esse|tal)|jamais)\b/i;
/** Forma aceita para declarar ausencia. */
// Sem \b no fim: "localizad" e prefixo de "localizado"/"localizada", e uma
// borda de palavra ali nunca casaria.
const DECLARES_NOT_LOCATED =
  /\b(n[aã]o (foi )?localizad|n[aã]o encontrei|sem evid[eê]ncia|n[aã]o consta nas fontes|nenhum documento)/i;
/** Palavras que afirmam execucao fisica a partir de pagamento (T19). */
const PHYSICAL_EXECUTION_WORDS = /\b(execu[cç][aã]o f[ií]sica|obra conclu[ií]da|100% (?:da )?obra)\b/i;

function extractMoneyMentions(text: string): string[] {
  return [...text.matchAll(/R\$\s?[\d.]+(?:,\d{2})?/g)].map((m) => m[0].replace(/\s+/g, ' '));
}

export function validateAnswer(input: ValidationInput): ValidationResult {
  const assessments: ClaimAssessment[] = [];
  const kept: AnswerClaim[] = [];
  const removed: AnswerClaim[] = [];
  const technical: string[] = [];

  for (const answerClaim of input.answerClaims) {
    const reasons: string[] = [];
    // Objeto em vez de `let`: o veredito e rebaixado dentro de um closure e
    // precisa ser lido depois com o tipo largo, nao com o inicial estreitado.
    const state: { verdict: ClaimVerdict } = { verdict: 'supported' };

    const downgrade = (to: ClaimVerdict, reason: string): void => {
      reasons.push(reason);
      const order: ClaimVerdict[] = ['supported', 'supported_with_caveat', 'unsupported', 'contradicted'];
      if (order.indexOf(to) > order.indexOf(state.verdict)) state.verdict = to;
    };

    // 1. Referencia vazia: nao existe afirmacao material sem evidencia.
    if (answerClaim.evidenceIds.length === 0) {
      downgrade('unsupported', 'afirmacao sem nenhuma referencia');
    }

    // 2. Cada referencia existe no conjunto recuperado (T35).
    const resolved: Evidence[] = [];
    for (const evidenceId of answerClaim.evidenceIds) {
      const evidence = input.retrievedEvidence.get(evidenceId);
      if (evidence === undefined) {
        downgrade('unsupported', `referencia ${evidenceId} nao esta no conjunto recuperado desta consulta`);
        continue;
      }
      resolved.push(evidence);
    }

    // 3. Municipio: evidencia de outro municipio nunca sustenta (T32, T33).
    for (const evidence of resolved) {
      const municipality = input.documentMunicipality.get(evidence.documentVersionId);
      if (municipality !== undefined && municipality !== input.contextMunicipalityId) {
        downgrade('contradicted', `evidencia ${evidence.id} pertence a outro municipio`);
      }
    }

    // 4. A afirmacao estruturada existe, esta publicavel e nao foi retirada.
    const structured = input.retrievedClaims.get(answerClaim.claimId);
    if (structured === undefined) {
      downgrade('unsupported', `afirmacao ${answerClaim.claimId} nao existe na base recuperada`);
    } else {
      if (!ANSWERABLE_VALIDATION_STATES.includes(structured.validationState)) {
        downgrade(
          'unsupported',
          `afirmacao em estado ${structured.validationState}: candidato ou em conflito nao sustenta resposta`,
        );
      }
      if (structured.retiredAt !== null) {
        downgrade('contradicted', 'afirmacao retirada por versao posterior');
      }
      // Uma afirmacao de ausencia NAO e uma afirmacao sem suporte: o briefing
      // 7.6 exige a secao "O que ainda nao foi confirmado" e o 12 exige lacuna
      // visivel. O que o validador precisa impedir e a virada de "nao
      // localizei" para "nao existe" (T24).
      if (structured.state === 'not_located') {
        if (DENIES_EXISTENCE.test(answerClaim.text)) {
          downgrade(
            'contradicted',
            'ausencia na base foi convertida em inexistencia do fato; a base nao prova que o evento nao ocorreu',
          );
        } else if (!DECLARES_NOT_LOCATED.test(answerClaim.text)) {
          downgrade(
            'unsupported',
            'campo sem evidencia apresentado como fato; a frase precisa dizer que nao foi localizado',
          );
        } else {
          downgrade('supported_with_caveat', 'ausencia declarada: nao localizado nas fontes consultadas');
        }
      }

      // 5. Suporte semantico minimo: o trecho precisa conter o valor citado
      //    (T36 - referencia que existe mas nao sustenta a frase).
      const mentions = extractMoneyMentions(answerClaim.text);
      if (mentions.length > 0) {
        const computed = input.computedAmounts.get(answerClaim.claimId);
        const structuredMoney = structured.money;
        const acceptable = new Set<string>();
        if (computed !== undefined) acceptable.add(formatMoney(computed).replace(/\s+/g, ' '));
        if (structuredMoney !== null) acceptable.add(formatMoney(structuredMoney).replace(/\s+/g, ' '));
        for (const mention of mentions) {
          if (acceptable.size === 0) {
            downgrade('unsupported', `valor ${mention} citado sem campo estruturado ou calculo correspondente`);
          } else if (!acceptable.has(mention)) {
            downgrade(
              'contradicted',
              `valor ${mention} divergente do campo estruturado (${[...acceptable].join(' ou ')})`,
            );
          }
        }
      }

      // 6. Frescor: afirmacao de estado presente exige evidencia dentro do
      //    limiar da classe do campo (T26, 14.3).
      const asserts = PRESENT_STATE_WORDS.test(answerClaim.text);
      if ((asserts || input.needsCurrentState) && structured.factDate !== null) {
        const maxAge = FRESHNESS_MAX_AGE_DAYS[structured.freshnessClass];
        const age = daysBetween(structured.factDate, input.today);
        if (maxAge === 0) {
          downgrade(
            'supported_with_caveat',
            'campo sem cadencia conhecida: nao pode ser apresentado como situacao atual',
          );
        } else if (maxAge !== null && age > maxAge) {
          downgrade(
            'supported_with_caveat',
            `evidencia de ${structured.factDate} tem ${age} dias e o limiar da classe ${structured.freshnessClass} e ${maxAge}; vale como ultimo registro, nao como situacao de hoje`,
          );
        }
      }
      if (asserts && structured.factDate === null) {
        downgrade('unsupported', 'estado presente afirmado sem data do fato');
      }

      // 7. Autoria exige relacao tipada de autoria (T09, 11.2).
      if (AUTHORSHIP_WORDS.test(answerClaim.text)) {
        const relations = input.personRelations.get(structured.subjectId) ?? [];
        const hasAuthorship = relations.some((r) => r === 'author' || r === 'coauthor');
        const onlyWeak = relations.length > 0 && relations.every((r) => NON_AUTHORSHIP_RELATIONS.includes(r));
        if (!hasAuthorship) {
          downgrade(
            'contradicted',
            onlyWeak
              ? `vinculo disponivel e ${relations.join(', ')}: mencao ou participacao nao comprova autoria`
              : 'autoria afirmada sem relacao tipada de autoria',
          );
        }
      }

      // 8. Pagamento integral nao autoriza afirmar execucao fisica (T19).
      if (PHYSICAL_EXECUTION_WORDS.test(answerClaim.text) && structured.predicate !== 'physical_progress') {
        downgrade(
          'contradicted',
          'execucao fisica afirmada a partir de campo que nao e medicao; pagamento nao comprova obra concluida',
        );
      }

      // 9. Estado divergente nao pode virar frase afirmativa lisa.
      if (structured.state === 'divergent' && !/diverg|conflito/i.test(answerClaim.text)) {
        downgrade('supported_with_caveat', 'campo em divergencia: o conflito precisa aparecer na frase');
      }
      if (structured.state === 'source_reported' && !/informou|segundo|relata|comunica/i.test(answerClaim.text)) {
        downgrade(
          'supported_with_caveat',
          'fato apenas informado por comunicacao: atribuir a informacao a fonte',
        );
      }
    }

    assessments.push({ claimId: answerClaim.claimId, verdict: state.verdict, reasons });
    if (state.verdict === 'unsupported' || state.verdict === 'contradicted') {
      removed.push(answerClaim);
      technical.push(`${answerClaim.claimId}: ${reasons.join('; ')}`);
    } else {
      kept.push(answerClaim);
    }
  }

  const verdict: ValidationResult['verdict'] =
    removed.length === 0
      ? 'passed'
      : kept.length === 0
        ? input.answerClaims.length === 0
          ? 'abstained'
          : 'blocked'
        : 'reduced';

  return { verdict, assessments, keptClaims: kept, removedClaims: removed, technicalReasons: technical };
}
