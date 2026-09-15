/**
 * Busca hibrida (15.1): identificacao exata de numeros e nomes; filtros
 * estruturados; busca textual; similaridade; classificacao; verificacao de
 * suporte.
 *
 * Limite deliberado (15.1): "A busca semantica deve ajudar a ENCONTRAR
 * documentos, nao PROVAR que dois registros sao o mesmo objeto." Por isso
 * nenhuma funcao aqui une entidades; candidatos empatados voltam para
 * desambiguacao (T02).
 */
import type { QueryRunner } from '../../db/src/pool.ts';
import type { AuthorizedContext, EntityKind } from '../../domain/src/types.ts';
import { plainDate, type DateRange, type PlainDate } from '../../domain/src/temporal.ts';

export interface EntityCandidate {
  readonly id: string;
  readonly kind: EntityKind;
  readonly officialName: string;
  readonly aliases: readonly string[];
  readonly localityName: string | null;
  readonly area: string | null;
  readonly matchKind:
    | 'exact_identifier'
    | 'exact_name'
    | 'name_contained'
    | 'curated_alias'
    | 'full_text'
    | 'trigram';
  readonly score: number;
}

/** Normalizacao para busca; a grafia original nunca e alterada (10.4). */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Numeros e identificadores administrativos. "Numero de contrato sem orgao e
 * exercicio nao e chave suficiente" (10.3), por isso devolvemos o padrao
 * reconhecido e nao uma chave.
 */
export interface RecognizedIdentifier {
  readonly raw: string;
  readonly kind: 'contract_like' | 'process_like' | 'cnpj' | 'year' | 'amendment_like';
  readonly normalized: string;
}

export function recognizeIdentifiers(question: string): RecognizedIdentifier[] {
  const found: RecognizedIdentifier[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: RecognizedIdentifier['kind'], normalized: string): void => {
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ raw, kind, normalized });
  };

  for (const m of question.matchAll(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/g)) {
    const raw = m[1];
    if (raw !== undefined) push(raw, 'cnpj', raw.replace(/\D/g, ''));
  }
  for (const m of question.matchAll(/\b(\d{1,6})\s*\/\s*(\d{4})\b/g)) {
    const [raw, num, year] = m;
    if (num !== undefined && year !== undefined) {
      push(raw, 'contract_like', `${num.replace(/^0+/, '')}/${year}`);
    }
  }
  for (const m of question.matchAll(/\bemenda\s+(?:n[oº.]?\s*)?([\w.-]{3,})/gi)) {
    const raw = m[1];
    if (raw !== undefined) push(raw, 'amendment_like', raw.toUpperCase());
  }
  for (const m of question.matchAll(/\b(?:19|20)(\d{2})\b/g)) {
    const raw = m[0];
    push(raw, 'year', raw);
  }
  return found;
}

export interface EntitySearchOptions {
  readonly kinds?: readonly EntityKind[];
  readonly limit?: number;
}

/**
 * Procura entidades em quatro caminhos, do mais forte para o mais fraco.
 * O caminho usado viaja no resultado: quem consome sabe se aquilo foi um
 * identificador oficial ou uma aproximacao de texto.
 */
export async function searchEntities(
  db: QueryRunner,
  context: AuthorizedContext,
  question: string,
  options: EntitySearchOptions = {},
): Promise<EntityCandidate[]> {
  const limit = Math.min(options.limit ?? 10, 50);
  const normalized = normalizeForSearch(question);
  const identifiers = recognizeIdentifiers(question);
  const kindFilter = options.kinds ?? null;
  const results = new Map<string, EntityCandidate>();

  const record = (row: RawEntityRow, matchKind: EntityCandidate['matchKind'], score: number): void => {
    const existing = results.get(row.id);
    if (existing !== undefined && existing.score >= score) return;
    results.set(row.id, {
      id: row.id,
      kind: row.kind as EntityKind,
      officialName: row.official_name,
      aliases: row.aliases,
      localityName: row.locality_name,
      area: row.area,
      matchKind,
      score,
    });
  };

  // 1. Identificador externo exato.
  for (const id of identifiers) {
    if (id.kind === 'year') continue;
    // Um identificador da pergunta pode vir parcial ("EX-0001" para
    // "EX-0001/2026"). Aceitamos containment do valor reconhecido dentro do
    // identificador da fonte, nunca o contrario, e nunca abaixo de 4
    // caracteres: "45" nao deve casar com qualquer contrato.
    const r = await db.query<RawEntityRow>(
      `${SELECT_ENTITY}
        where ($1::text[] is null or e.kind::text = any($1))
          and length(regexp_replace($2, '[^0-9A-Za-z]', '', 'g')) >= 4
          and exists (
            select 1 from jsonb_each_text(e.external_ids) kv
             where position(
                     upper(regexp_replace($2, '[^0-9A-Za-z]', '', 'g'))
                     in upper(regexp_replace(kv.value, '[^0-9A-Za-z]', '', 'g'))
                   ) > 0
          )
        limit $3`,
      [kindFilter, id.normalized, limit],
    );
    for (const row of r.rows) record(row, 'exact_identifier', 1);
  }

  // 2. Nome oficial exato (normalizado).
  const exact = await db.query<RawEntityRow>(
    `${SELECT_ENTITY}
      where ($1::text[] is null or e.kind::text = any($1))
        and e.name_normalized = $2
      limit $3`,
    [kindFilter, normalized, limit],
  );
  for (const row of exact.rows) record(row, 'exact_name', 0.95);

  // 2b. Nome oficial completo contido na pergunta. Nao e igualdade, mas e tao
  // forte quanto: quem escreveu o nome inteiro nao deveria receber uma
  // pergunta de desambiguacao (15.2).
  const contained = await db.query<RawEntityRow>(
    `${SELECT_ENTITY}
      where ($1::text[] is null or e.kind::text = any($1))
        and length(e.name_normalized) >= 8
        and position(e.name_normalized in $2) > 0
      limit $3`,
    [kindFilter, normalized, limit],
  );
  for (const row of contained.rows) record(row, 'name_contained', 0.93);

  // 3. Apelido local curado (T03): encontra pelo alias, responde com o nome oficial.
  const aliasHit = await db.query<RawEntityRow>(
    `${SELECT_ENTITY}
      where ($1::text[] is null or e.kind::text = any($1))
        and exists (
          select 1 from unnest(e.aliases) a
           where $2 like '%' || lower(a) || '%' or lower(a) = $2
        )
      limit $3`,
    [kindFilter, normalized, limit],
  );
  for (const row of aliasHit.rows) record(row, 'curated_alias', 0.9);

  // 4. Busca textual em portugues.
  const fts = await db.query<RawEntityRow & { rank: number }>(
    `select ${ENTITY_COLS},
            ts_rank_cd(e.search_vector, websearch_to_tsquery('portuguese', $2)) as rank
       ${ENTITY_FROM}
      where ($1::text[] is null or e.kind::text = any($1))
        and e.search_vector @@ websearch_to_tsquery('portuguese', $2)
      order by rank desc
      limit $3`,
    [kindFilter, question, limit],
  );
  // O teto do caminho textual precisa ficar pelo menos RESOLUTION_MARGIN
  // abaixo de um nome exato (0.95) e de um nome contido (0.93). Com teto 0.85 a
  // diferenca era de 0.10 e uma busca por nome completo caia em desambiguacao
  // por causa de homonimos parciais.
  for (const row of fts.rows) record(row, 'full_text', Math.min(0.75, 0.45 + Number(row.rank)));

  // 5. Trigrama: ultimo recurso, para grafia aproximada de nome local.
  const trigram = await db.query<RawEntityRow & { sim: number }>(
    `select ${ENTITY_COLS}, extensions.similarity(e.name_normalized, $2::text) as sim
       ${ENTITY_FROM}
      where ($1::text[] is null or e.kind::text = any($1))
        and extensions.similarity(e.name_normalized, $2::text) >= 0.3
      order by sim desc
      limit $3`,
    [kindFilter, normalized, limit],
  );
  for (const row of trigram.rows) record(row, 'trigram', Math.min(0.7, Number(row.sim)));

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

interface RawEntityRow {
  id: string;
  kind: string;
  official_name: string;
  aliases: string[];
  locality_name: string | null;
  area: string | null;
}

const ENTITY_COLS = `e.id, e.kind::text as kind, e.official_name, e.aliases,
         l.official_name as locality_name, e.area`;

const ENTITY_FROM = `from ma.entities e
    left join ma.localities l on l.id = e.locality_id`;

const SELECT_ENTITY = `select ${ENTITY_COLS} ${ENTITY_FROM}`;

/**
 * Desambiguacao (6.1, T02): "Nao escolhe silenciosamente a primeira."
 * Devolve o unico candidato so quando ha um vencedor claro por caminho forte.
 */
export interface Resolution {
  readonly kind: 'resolved' | 'ambiguous' | 'not_found';
  readonly entity: EntityCandidate | null;
  readonly options: readonly EntityCandidate[];
}

/** Diferenca minima de pontuacao para considerar que ha um vencedor claro. */
export const RESOLUTION_MARGIN = 0.15;

/**
 * Regra de desambiguacao, calibrada entre duas exigencias opostas do briefing:
 *  - 6.1 / T02: "Nao escolhe silenciosamente a primeira" quando ha duas
 *    entidades compativeis.
 *  - 15.2: "Nao fazer cinco perguntas tecnicas para responder algo que os
 *    identificadores ja resolvem."
 *
 * Um unico candidato resolve. Dois ou mais resolvem apenas quando o primeiro
 * esta claramente a frente; caso contrario a escolha volta para o usuario.
 */
export function resolveOne(candidates: readonly EntityCandidate[]): Resolution {
  const [first, second] = candidates;
  if (first === undefined) return { kind: 'not_found', entity: null, options: [] };
  if (second === undefined) return { kind: 'resolved', entity: first, options: [first] };
  if (first.score - second.score >= RESOLUTION_MARGIN) {
    return { kind: 'resolved', entity: first, options: candidates };
  }
  return { kind: 'ambiguous', entity: null, options: candidates };
}

/**
 * Sinaliza que a entidade foi encontrada por aproximacao de texto, nao por
 * identificador ou nome. O produto exibe isso junto da resposta; nao e motivo
 * para recusar a consulta, e sim informacao sobre como o objeto foi achado.
 */
export function isWeakMatch(candidate: EntityCandidate): boolean {
  return candidate.matchKind === 'trigram' || candidate.matchKind === 'full_text';
}

export interface DocumentHit {
  readonly documentVersionId: string;
  readonly title: string;
  readonly sourceCode: string;
  readonly publicationDate: PlainDate | null;
  readonly snippet: string;
  readonly rank: number;
  readonly isSynthetic: boolean;
  /** Evidencias ancoradas no documento, usadas para a camada "Comprove". */
  readonly evidenceIds: readonly string[];
}

/** Busca textual no acervo, com filtro estruturado de periodo. */
export async function searchDocuments(
  db: QueryRunner,
  question: string,
  options: {
    readonly period?: DateRange | null;
    readonly limit?: number;
    readonly documentTypes?: readonly string[] | null;
  } = {},
): Promise<DocumentHit[]> {
  const limit = Math.min(options.limit ?? 10, 50);
  const period = options.period ?? null;
  const documentTypes = options.documentTypes ?? null;
  const result = await db.query<{
    id: string;
    title_original: string;
    code: string;
    publication_date: string | null;
    snippet: string;
    rank: number;
    is_synthetic: boolean;
    evidence_ids: string[];
  }>(
    `select d.id, d.title_original, s.code, d.publication_date::text as publication_date,
            ts_headline('portuguese', coalesce(d.text_content, d.title_original),
                        websearch_to_tsquery('portuguese', $1),
                        'MaxFragments=3, MinWords=18, MaxWords=55, StartSel=<<, StopSel=>>') as snippet,
            ts_rank_cd(d.search_vector, websearch_to_tsquery('portuguese', $1)) as rank,
            d.is_synthetic,
            coalesce(
              (select array_agg(ev.id order by ev.obtained_at desc)
                 from ma.evidence ev
                where ev.document_version_id = d.id),
              '{}'
            ) as evidence_ids
       from ma.document_versions d
       join ma.sources s on s.id = d.source_id
      where d.search_vector @@ websearch_to_tsquery('portuguese', $1)
        and not exists (
          select 1 from ma.document_versions newer
           where newer.supersedes_id = d.id
        )
        and ($2::date is null or coalesce(
              d.publication_date,
              case when d.fiscal_year between 1900 and 2100 then make_date(d.fiscal_year, 1, 1) end,
              d.reference_date
            ) >= $2::date)
        and ($3::date is null or coalesce(
              d.publication_date,
              case when d.fiscal_year between 1900 and 2100 then make_date(d.fiscal_year, 12, 31) end,
              d.reference_date
            ) <= $3::date)
        and ($5::text[] is null or d.document_type = any($5))
      order by rank desc, d.publication_date desc nulls last
      limit $4`,
    [question, period?.from ?? null, period?.to ?? null, limit, documentTypes],
  );
  return result.rows.map((r) => ({
    documentVersionId: r.id,
    title: r.title_original,
    sourceCode: r.code,
    publicationDate: r.publication_date === null ? null : plainDate(r.publication_date),
    snippet: r.snippet,
    rank: Number(r.rank),
    isSynthetic: r.is_synthetic,
    evidenceIds: r.evidence_ids,
  }));
}
