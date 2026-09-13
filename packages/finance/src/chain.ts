/**
 * Cadeia de rastreabilidade (11.3):
 * emenda -> instrumento -> empenho/operacao -> repasse -> registro no executor
 * -> contratacao -> pagamento -> execucao e entrega.
 *
 * "Cada seta exige um identificador compartilhado ou evidencia documental
 * explicita. Valores semelhantes, mesma area ou datas proximas nao bastam."
 */
import type { PlainDate } from '../../domain/src/temporal.ts';

export const CHAIN_STEPS = [
  'amendment',
  'instrument',
  'commitment',
  'transfer',
  'executor_record',
  'procurement',
  'payment',
  'delivery',
] as const;
export type ChainStep = (typeof CHAIN_STEPS)[number];

export const CHAIN_STEP_LABEL: Record<ChainStep, string> = {
  amendment: 'Emenda',
  instrument: 'Instrumento',
  commitment: 'Empenho / operacao',
  transfer: 'Repasse ao destinatario',
  executor_record: 'Registro no executor',
  procurement: 'Contratacao',
  payment: 'Pagamento',
  delivery: 'Execucao e entrega',
};

export interface ChainLink {
  readonly fromStep: ChainStep;
  readonly toStep: ChainStep;
  readonly sharedIdentifier: string | null;
  readonly evidenceIds: readonly string[];
  readonly factDate: PlainDate | null;
}

export type LinkVerdict = 'documented' | 'not_located' | 'rejected_weak_signal';

export interface ChainAssessment {
  readonly steps: readonly { readonly step: ChainStep; readonly present: boolean; readonly evidenceIds: readonly string[] }[];
  readonly links: readonly { readonly link: ChainLink; readonly verdict: LinkVerdict; readonly reason: string }[];
  readonly gaps: readonly string[];
  readonly complete: boolean;
}

export function assessChain(
  presentSteps: ReadonlyMap<ChainStep, readonly string[]>,
  links: readonly ChainLink[],
): ChainAssessment {
  const steps = CHAIN_STEPS.map((step) => ({
    step,
    present: presentSteps.has(step),
    evidenceIds: presentSteps.get(step) ?? [],
  }));

  const assessed = links.map((link) => {
    if (link.sharedIdentifier !== null && link.sharedIdentifier.trim() !== '') {
      return {
        link,
        verdict: 'documented' as LinkVerdict,
        reason: `identificador compartilhado ${link.sharedIdentifier}`,
      };
    }
    if (link.evidenceIds.length > 0) {
      return {
        link,
        verdict: 'documented' as LinkVerdict,
        reason: 'evidencia documental explicita do vinculo',
      };
    }
    return {
      link,
      verdict: 'rejected_weak_signal' as LinkVerdict,
      reason:
        'sem identificador compartilhado nem evidencia do vinculo; semelhanca de valor, area ou data nao comprova a ligacao',
    };
  });

  const gaps: string[] = [];
  for (const s of steps) {
    if (!s.present) gaps.push(`Elo nao localizado: ${CHAIN_STEP_LABEL[s.step]}`);
  }
  for (const a of assessed) {
    if (a.verdict !== 'documented') {
      gaps.push(
        `Ligacao nao comprovada entre ${CHAIN_STEP_LABEL[a.link.fromStep]} e ${CHAIN_STEP_LABEL[a.link.toStep]}: ${a.reason}`,
      );
    }
  }

  return {
    steps,
    links: assessed,
    gaps,
    complete: gaps.length === 0,
  };
}
