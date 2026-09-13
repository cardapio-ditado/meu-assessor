/**
 * API interna (Anexo B). Roteamento sem framework: o objetivo do piloto e
 * demonstrar os contratos e os controles, nao escolher uma dependencia.
 *
 * Controle indispensavel em toda rota (B.1): a organizacao vem da sessao no
 * servidor. Nenhuma rota aceita tenant_id do cliente.
 *
 * Este modulo nao abre porta. Ele exporta `handle(req, res)`, usado tanto pelo
 * servidor local (services/api/src/server.ts) quanto pela funcao serverless
 * (api/index.ts). Assim o mesmo codigo responde nos dois ambientes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as sessions from './sessions.ts';
import { closePool, withContext, withoutTenant } from '../../../packages/db/src/pool.ts';
import { AuthorizationError, contextFor, hasRole, resolveContexts } from '../../../packages/db/src/auth.ts';
import { ask, recordAnswer } from '../../../packages/answer/src/engine.ts';
import {
  getClaims,
  getClaimsKnownAt,
  getClaimsValidOn,
  getConflicts,
  getCoverage,
  getEntity,
  getEvidence,
  getGaps,
  getPersonRelations,
  getRecentCards,
  getTimeline,
} from '../../../packages/db/src/repository.ts';
import { searchEntities } from '../../../packages/retrieval/src/search.ts';
import { addDays, dateRange, plainDate, todayIn, tryPlainDate } from '../../../packages/domain/src/temporal.ts';
import { DEFAULT_RECENT_DAYS } from '../../../packages/answer/src/planner.ts';
import type { AuthorizedContext } from '../../../packages/domain/src/types.ts';
import { ENTITY_KIND_LABEL } from '../../../packages/domain/src/states.ts';

/**
 * Raiz dos arquivos estaticos. Nao pode depender da profundidade do arquivo:
 * o mesmo modulo roda em services/api/src e, compilado, em
 * dist/services/api/src. Subimos ate encontrar apps/web.
 */
function findWebRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'apps', 'web');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Em execucao serverless os estaticos sao servidos pela plataforma e este
  // caminho nao e usado; devolver algo inexistente vira 404, nao excecao.
  return join(dirname(fileURLToPath(import.meta.url)), 'apps', 'web');
}

const webRoot = findWebRoot();

/**
 * 16.5: uma pergunta nao inicia pesquisa pesada duas vezes por clique duplo.
 * Este mapa e por instancia. Em execucao serverless ele protege contra o
 * clique duplo que cai na MESMA instancia, que e o caso comum; a garantia
 * forte contra repeticao de trabalho caro e a chave de idempotencia em
 * ma.research_jobs, nao este mapa.
 */
const inFlight = new Map<string, Promise<unknown>>();

interface Json {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Json {
  return { status, body, headers };
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function cookieToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[sessions.SESSION_COOKIE];
}

/**
 * O atributo Secure impede o navegador de enviar o cookie em http. Em
 * implantacao isso e obrigatorio; em desenvolvimento local em http ele
 * tornaria o login impossivel. A decisao vem da conexao, nao de um flag que
 * alguem pode esquecer ligado em producao.
 */
function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (proto !== undefined) return proto.split(',')[0]?.trim() === 'https';
  const host = (req.headers.host ?? '').split(':')[0];
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
}

async function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > maxBytes) throw new Error('corpo da requisicao acima do limite');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON invalido');
  }
}

/** Comparacao de senha em tempo constante (piloto: senha unica de demonstracao). */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(pathname: string): Promise<Json> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  // Impede travessia de diretorio.
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const full = join(webRoot, safe);
  if (!full.startsWith(webRoot)) return json(403, { error: 'caminho nao permitido' });
  try {
    const content = await readFile(full);
    return {
      status: 200,
      body: content,
      headers: {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        // Sem inline script: o app usa arquivo externo.
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    };
  } catch {
    return json(404, { error: 'nao encontrado' });
  }
}

async function route(req: IncomingMessage, url: URL): Promise<Json> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // Navegadores pedem /favicon.ico mesmo com <link rel=icon>. Responder 204
  // evita um 404 no console que faria um erro real passar despercebido.
  if (path === '/favicon.ico') return { status: 204, body: Buffer.alloc(0) };

  // ---- Acesso (T01 / 7.2) --------------------------------------------------
  if (method === 'POST' && path === '/v1/sessions') {
    const body = (await readBody(req)) as { login?: string; password?: string; tenantSlug?: string };
    const login = typeof body.login === 'string' ? body.login : '';
    const password = typeof body.password === 'string' ? body.password : '';
    // 17.3: nenhum segredo no codigo. Sem DEMO_PASSWORD e SESSION_SECRET
    // definidas, o acesso simplesmente nao funciona.
    const expected = process.env['DEMO_PASSWORD'] ?? '';
    // 7.2: "Nao revelar a existencia de contas em mensagens de erro."
    const generic = json(401, { error: 'acesso nao disponivel para estas credenciais' });
    if (expected === '') {
      console.error('DEMO_PASSWORD nao definida: nenhum acesso sera concedido.');
      return generic;
    }
    if (!sessions.hasSecret()) {
      console.error('SESSION_SECRET ausente ou curta: nenhuma sessao pode ser assinada.');
      return generic;
    }
    if (!constantTimeEquals(password, expected)) return generic;
    let contexts;
    try {
      contexts = await resolveContexts(login);
    } catch {
      return generic;
    }
    if (contexts.length === 0) return generic;
    const chosen =
      typeof body.tenantSlug === 'string'
        ? contexts.find((c) => c.tenantSlug === body.tenantSlug)
        : contexts.length === 1
          ? contexts[0]
          : undefined;
    if (chosen === undefined) {
      // 25.1: troca de contexto explicita quando ha mais de uma autorizacao.
      return json(300, {
        error: 'escolha a organizacao',
        options: contexts.map((c) => ({ tenantSlug: c.tenantSlug, municipality: c.municipalityName })),
      });
    }
    const { cookie } = await sessions.create(
      login,
      chosen.tenantSlug,
      req.headers['user-agent'],
      isSecureRequest(req),
    );
    // Limpeza oportunista: 20.5 pede retencao definida, e nao ha agendador.
    void sessions.purgeExpired().catch(() => undefined);
    return json(
      200,
      { tenantSlug: chosen.tenantSlug, municipality: chosen.municipalityName, roles: chosen.roles },
      { 'set-cookie': cookie },
    );
  }

  if (method === 'DELETE' && path === '/v1/sessions') {
    // Revoga no banco: apagar o cookie sozinho deixaria a sessao valida para
    // quem tivesse copiado o token (7.2, dispositivo perdido).
    await sessions.revoke(cookieToken(req));
    return json(200, { ok: true }, { 'set-cookie': sessions.clearedCookie(isSecureRequest(req)) });
  }

  // ---- A partir daqui tudo exige sessao -----------------------------------
  const session = await sessions.resolve(cookieToken(req));
  if (session === null) {
    if (path.startsWith('/v1/')) return json(401, { error: 'sessao necessaria' });
    return serveStatic(path);
  }

  let context: AuthorizedContext;
  try {
    context = await contextFor(session.login, session.tenantSlug);
  } catch (error) {
    if (error instanceof AuthorizationError) return json(403, { error: 'acesso nao disponivel' });
    throw error;
  }

  // GET /v1/me - perfil e organizacao. Nao revela outras organizacoes.
  if (method === 'GET' && path === '/v1/me') {
    return json(200, {
      tenantSlug: context.tenantSlug,
      municipality: context.municipalityName,
      timeZone: context.timeZone,
      roles: context.roles,
      accessClasses: context.accessClasses,
      today: todayIn(context.timeZone),
    });
  }

  // GET /v1/home - cartoes e indicadores de cobertura
  if (method === 'GET' && path === '/v1/home') {
    const today = todayIn(context.timeZone);
    const period = dateRange(addDays(today, -DEFAULT_RECENT_DAYS), today);
    return withContext(context, async (db) => {
      const cards = await getRecentCards(db, period, 5);
      const coverage = await getCoverage(db);
      return json(200, {
        municipality: context.municipalityName,
        period: { from: period.from, to: period.to, days: DEFAULT_RECENT_DAYS },
        cards,
        coverage,
        // 14.2: "Atualizado periodicamente" so pode ser dito quando existe
        // conector habilitado e verificado com coleta bem-sucedida. Uma carga
        // manual de fixture NAO autoriza essa frase, e "em tempo real" nao deve
        // ser usado em nenhuma hipotese.
        coverageNotice: coverage.some((c) => c.liveConnector && c.lastSuccessAt !== null)
          ? 'Atualizado periodicamente, conforme disponibilidade das fontes.'
          : 'Nenhum conector de fonte publica esta em operacao. Os cartoes abaixo vem do recorte ' +
            'carregado manualmente e nao refletem coleta automatica.',
      });
    });
  }

  // POST /v1/questions - consulta e resposta
  if (method === 'POST' && path === '/v1/questions') {
    const body = (await readBody(req)) as { question?: string; idempotencyKey?: string };
    const question = typeof body.question === 'string' ? body.question : '';
    if (question.trim() === '') return json(400, { error: 'pergunta vazia' });
    if (question.length > 1000) return json(400, { error: 'pergunta acima do limite de 1000 caracteres' });

    const key = `${context.tenantId}:${session.login}:${
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey : question
    }`;
    const running = inFlight.get(key);
    if (running !== undefined) return json(200, await running);

    const work = withContext(context, async (db) => {
      const result = await ask(db, context, question);
      await recordAnswer(db, context, result);
      return {
        ...result.envelope,
        plan: {
          intent: result.plan.intent,
          period: result.plan.period,
          periodIsDefault: result.plan.periodIsDefault,
          riskClass: result.plan.riskClass,
        },
        validator: {
          verdict: result.validation.verdict,
          removed: result.validation.removedClaims.length,
          reasons: result.validation.technicalReasons,
        },
        candidates: result.candidates.slice(0, 5).map((c) => ({
          id: c.id,
          name: c.officialName,
          kind: c.kind,
          kindLabel: ENTITY_KIND_LABEL[c.kind] ?? c.kind,
          locality: c.localityName,
          matchKind: c.matchKind,
        })),
        latencyMs: result.latencyMs,
      };
    });
    inFlight.set(key, work);
    try {
      return json(200, await work);
    } finally {
      // Libera depois de um instante para absorver o clique duplo.
      setTimeout(() => inFlight.delete(key), 2000);
    }
  }

  // GET /v1/entities?q= - busca e desambiguacao
  if (method === 'GET' && path === '/v1/entities') {
    const q = url.searchParams.get('q') ?? '';
    if (q.trim() === '') return json(400, { error: 'parametro q obrigatorio' });
    return withContext(context, async (db) => {
      const candidates = await searchEntities(db, context, q, { limit: 20 });
      return json(200, { results: candidates });
    });
  }

  // GET /v1/entities/{id} - dossie. Autorizacao por objeto, nao pela URL (T32).
  const entityMatch = /^\/v1\/entities\/([0-9a-f-]{36})$/.exec(path);
  if (method === 'GET' && entityMatch !== null) {
    const id = entityMatch[1] as string;
    // "Qual era o prazo em X?" (T22) e "o que sabiamos em X?" (T23)
    const validOn = tryPlainDate(url.searchParams.get('validOn'));
    const knownAt = tryPlainDate(url.searchParams.get('knownAt'));
    return withContext(context, async (db) => {
      const entity = await getEntity(db, id);
      // Objeto de outra organizacao nao existe para esta sessao: a resposta e
      // 404, nao 403, para nao confirmar a existencia (B.5).
      if (entity === null) return json(404, { error: 'nao encontrado' });
      const claims =
        validOn !== null
          ? await getClaimsValidOn(db, id, validOn)
          : knownAt !== null
            ? await getClaimsKnownAt(db, id, knownAt)
            : await getClaims(db, id);
      return json(200, {
        entity,
        temporalAxis: validOn !== null ? 'validade administrativa' : knownAt !== null ? 'conhecimento da plataforma' : 'versao vigente',
        claims,
        timeline: await getTimeline(db, id),
        gaps: await getGaps(db, id),
        conflicts: await getConflicts(db, id),
        relations: entity.kind === 'public_person' ? await getPersonRelations(db, id) : [],
      });
    });
  }

  // GET /v1/evidence/{id} - conferir o suporte
  const evidenceMatch = /^\/v1\/evidence\/([0-9a-f-]{36})$/.exec(path);
  if (method === 'GET' && evidenceMatch !== null) {
    const id = evidenceMatch[1] as string;
    return withContext(context, async (db) => {
      const found = await getEvidence(db, [id]);
      const evidence = found.get(id);
      if (evidence === undefined) return json(404, { error: 'nao encontrado' });
      const doc = await db.query<{
        title_original: string; url_original: string | null; publication_date: string | null;
        collected_at: string; content_hash: string; record_version: number; is_synthetic: boolean;
        source_code: string; extraction_method: string;
      }>(
        `select d.title_original, d.url_original, d.publication_date::text as publication_date,
                d.collected_at::text as collected_at, d.content_hash, d.record_version,
                d.is_synthetic, s.code as source_code, d.extraction_method
           from ma.document_versions d join ma.sources s on s.id = d.source_id
          where d.id = $1`,
        [evidence.documentVersionId],
      );
      return json(200, {
        evidence,
        document: doc.rows[0] ?? null,
        // 12.1: o hash controla a integridade da COPIA; nao certifica
        // autenticidade nem validade juridica do documento.
        hashNotice:
          'O hash confere a integridade da copia coletada. Nao comprova autenticidade, autoria nem validade juridica.',
      });
    });
  }

  // GET /v1/admin/source-runs - papel administrativo
  if (method === 'GET' && path === '/v1/admin/source-runs') {
    if (!hasRole(context, 'municipal_admin', 'data_curator', 'platform_ops', 'auditor')) {
      return json(403, { error: 'papel sem acesso a esta area' });
    }
    return withContext(context, async (db) => {
      const runs = await db.query(
        `select sr.id, s.code, sd.name, sr.started_at, sr.finished_at, sr.outcome,
                sr.obtained_count, sr.rejected_count, sr.error_class
           from ma.source_runs sr
           join ma.source_datasets sd on sd.id = sr.dataset_id
           join ma.sources s on s.id = sd.source_id
          order by sr.started_at desc limit 50`,
      );
      const reviews = await db.query(
        `select id, kind, reason, impact, priority, state, created_at
           from ma.review_queue where state in ('open','in_review')
          order by priority desc, created_at limit 50`,
      );
      return json(200, { runs: runs.rows, reviewQueue: reviews.rows });
    });
  }

  // POST /v1/feedback - "ha um erro" abre item de revisao (21.4)
  if (method === 'POST' && path === '/v1/feedback') {
    const body = (await readBody(req)) as { answerId?: string; note?: string };
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note === '') return json(400, { error: 'descreva o problema' });
    return withContext(context, async (db) => {
      await db.query(
        `insert into ma.review_queue (tenant_id, kind, reason, impact, original_extraction, priority)
         values ($1, 'feedback', $2, 'affects_emitted_answer', $3::jsonb, 70)`,
        [
          context.tenantId,
          `Erro sinalizado pelo usuario: ${note.slice(0, 500)}`,
          JSON.stringify({ answerId: body.answerId ?? null, login: session.login }),
        ],
      );
      // 21.4: aprovacao do usuario nao torna um fato verdadeiro, e um erro
      // sinalizado nao muda a base sozinho.
      return json(201, {
        ok: true,
        notice: 'O relato abriu um item de revisao. A base nao muda sem revisao humana.',
      });
    });
  }

  // POST /v1/transcriptions - sem provedor configurado o produto diz isso
  if (method === 'POST' && path === '/v1/transcriptions') {
    if ((process.env['STT_PROVIDER'] ?? 'none') === 'none') {
      // 28.2: nao simular sucesso de um recurso indisponivel.
      return json(503, {
        error: 'transcricao nao configurada',
        notice:
          'Nenhum provedor de transcricao esta configurado neste ambiente (STT_PROVIDER=none). ' +
          'A gravacao funciona no navegador, mas o audio nao sera transcrito. Use o campo de texto.',
      });
    }
    return json(501, { error: 'provedor configurado mas nao implementado neste piloto' });
  }

  if (path.startsWith('/v1/')) return json(404, { error: 'rota nao encontrada' });
  return serveStatic(path);
}

/**
 * Ponto de entrada unico. O servidor local e a funcao serverless chamam isto.
 */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const requestId = randomUUID();
  try {
    send(res, await route(req, url), requestId);
  } catch (error) {
    // 23.1: cada resposta tem identificador para diagnostico, sem guardar
    // dados pessoais desnecessarios no log.
    console.error(`[${requestId}] ${url.pathname}: ${(error as Error).message}`);
    send(res, json(500, { error: 'erro interno', requestId }), requestId);
  }
}

function send(res: ServerResponse, result: Json, requestId: string): void {
  const headers: Record<string, string> = { 'x-request-id': requestId, ...(result.headers ?? {}) };
  if (Buffer.isBuffer(result.body)) {
    res.writeHead(result.status, headers);
    res.end(result.body);
    return;
  }
  res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(result.body, null, 2));
}

/** Avisos de configuracao, uteis no log de arranque dos dois ambientes. */
export function configWarnings(): string[] {
  const out: string[] = [];
  if ((process.env['DATABASE_URL'] ?? '') === '') out.push('DATABASE_URL ausente: nenhuma consulta funciona.');
  if (!sessions.hasSecret()) out.push('SESSION_SECRET ausente ou com menos de 32 caracteres: nenhum login e aceito.');
  if ((process.env['DEMO_PASSWORD'] ?? '') === '') out.push('DEMO_PASSWORD ausente: nenhum login e aceito.');
  return out;
}

export { webRoot };
