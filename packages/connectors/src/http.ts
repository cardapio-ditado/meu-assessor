/**
 * Transporte de coleta. Briefing 13.4 (conector robusto) e 20.4 (documentos e
 * URLs como conteudo nao confiavel).
 *
 * Controles implementados aqui, nao delegados ao prompt:
 *  - allowlist de hosts: sem INGESTION_ALLOWED_HOSTS nao ha coleta externa
 *  - bloqueio de IP privado, loopback e metadados de infraestrutura (T31)
 *  - REVALIDACAO a cada redirecionamento, porque a URL publica pode redirecionar
 *    para a rede interna ("Isso tambem se aplica a links encontrados em portais
 *    oficiais")
 *  - timeout, limite de bytes, retentativa com espera progressiva
 *  - falha de autenticacao NAO gera retentativa infinita
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ConnectorErrorKind =
  | 'host_not_allowed'
  | 'blocked_address'
  | 'timeout'
  | 'too_large'
  | 'auth_failed'
  | 'rate_limited'
  | 'schema_changed'
  | 'http_error'
  | 'network_error';

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  /** Falha de autenticacao e esquema NAO sao retentaveis (13.4). */
  readonly retryable: boolean;

  constructor(message: string, kind: ConnectorErrorKind, retryable: boolean) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Faixas que um coletor nunca deve alcancar (20.4). */
function isBlockedAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) {
    return true;
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local e metadados de nuvem
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function allowedHosts(): string[] {
  const raw = process.env['INGESTION_ALLOWED_HOSTS'] ?? '';
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
}

export interface GuardResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly resolvedAddresses: readonly string[];
}

/**
 * Valida uma URL antes de qualquer requisicao. Chamada de novo a cada salto de
 * redirecionamento; um host permitido que redireciona para 127.0.0.1 e barrado
 * no segundo salto.
 */
export async function guardUrl(rawUrl: string, hosts: readonly string[] = allowedHosts()): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL invalida', resolvedAddresses: [] };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `esquema ${url.protocol} nao permitido`, resolvedAddresses: [] };
  }
  // URL.hostname devolve IPv6 entre colchetes ("[::1]"). Sem remove-los,
  // isIP() nao reconhece o endereco e a checagem de faixa bloqueada seria
  // contornada por um host IPv6 literal.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const permitted = hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!permitted) {
    return {
      ok: false,
      reason:
        hosts.length === 0
          ? 'INGESTION_ALLOWED_HOSTS vazio: nenhuma coleta externa autorizada'
          : `host ${host} fora da allowlist`,
      resolvedAddresses: [],
    };
  }

  if (isIP(host) !== 0) {
    return isBlockedAddress(host)
      ? { ok: false, reason: `endereco ${host} pertence a faixa bloqueada`, resolvedAddresses: [host] }
      : { ok: true, reason: 'ok', resolvedAddresses: [host] };
  }

  let addresses: string[];
  try {
    const records = await lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch (error) {
    return { ok: false, reason: `falha de resolucao DNS: ${(error as Error).message}`, resolvedAddresses: [] };
  }
  const blocked = addresses.filter(isBlockedAddress);
  if (blocked.length > 0) {
    return {
      ok: false,
      reason: `host ${host} resolve para faixa bloqueada (${blocked.join(', ')})`,
      resolvedAddresses: addresses,
    };
  }
  return { ok: true, reason: 'ok', resolvedAddresses: addresses };
}

export interface FetchResult {
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: Buffer;
  readonly attempts: number;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRetries?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Espera progressiva. Nao usada em falha de autenticacao (13.4). */
function backoffMs(attempt: number): number {
  return Math.min(16_000, 2_000 * 2 ** (attempt - 1));
}

export async function fetchGuarded(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? Number(process.env['INGESTION_TIMEOUT_MS'] ?? 25_000);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRetries = options.maxRetries ?? 3;
  const maxRedirects = options.maxRedirects ?? 5;
  const userAgent = process.env['INGESTION_USER_AGENT'] ?? 'MeuAssessor/0.1';

  let attempt = 0;
  let lastError: ConnectorError | null = null;

  while (attempt < maxRetries) {
    attempt += 1;
    try {
      let currentUrl = rawUrl;
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const guard = await guardUrl(currentUrl);
        if (!guard.ok) throw new ConnectorError(guard.reason, hop === 0 ? 'host_not_allowed' : 'blocked_address', false);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(currentUrl, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': userAgent, ...(options.headers ?? {}) },
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location === null) throw new ConnectorError('redirecionamento sem Location', 'http_error', false);
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new ConnectorError(`acesso rejeitado (${response.status})`, 'auth_failed', false);
        }
        if (response.status === 429) {
          throw new ConnectorError('limite do provedor atingido (429)', 'rate_limited', true);
        }
        if (response.status >= 500) {
          throw new ConnectorError(`erro do provedor (${response.status})`, 'http_error', true);
        }
        if (!response.ok) {
          throw new ConnectorError(`resposta ${response.status}`, 'http_error', false);
        }

        const declared = response.headers.get('content-length');
        if (declared !== null && Number(declared) > maxBytes) {
          throw new ConnectorError(`conteudo de ${declared} bytes acima do limite`, 'too_large', false);
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > maxBytes) {
          throw new ConnectorError(`conteudo de ${body.byteLength} bytes acima do limite`, 'too_large', false);
        }
        return {
          status: response.status,
          finalUrl: currentUrl,
          contentType: response.headers.get('content-type'),
          body,
          attempts: attempt,
        };
      }
      throw new ConnectorError('excesso de redirecionamentos', 'http_error', false);
    } catch (error) {
      const connectorError =
        error instanceof ConnectorError
          ? error
          : (error as Error).name === 'AbortError'
            ? new ConnectorError(`timeout de ${timeoutMs}ms`, 'timeout', true)
            : new ConnectorError((error as Error).message, 'network_error', true);
      lastError = connectorError;
      // Falha de autenticacao nao deve disparar tentativas infinitas (13.4).
      if (!connectorError.retryable) throw connectorError;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
  throw lastError ?? new ConnectorError('falha desconhecida', 'network_error', false);
}
