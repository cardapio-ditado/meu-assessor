/**
 * Executor de coleta (§13, §14.1).
 *
 * Dois modos:
 *   --probe    testa o acesso a cada fonte do catalogo e grava o resultado,
 *              sem coletar nada. E a etapa E1 do §24.2.
 *   (padrao)   coleta as fontes habilitadas.
 *
 * Este processo NAO e um agendador. O §14.1 exige agendador persistente e
 * trabalhadores independentes da sessao do gestor, comprovados com execucoes
 * registradas. Nada disso existe nesta entrega: este arquivo e o comando que um
 * agendador chamaria. Ver README, tabela de situacao.
 */
import { closePool, withContext } from '../../../packages/db/src/pool.ts';
import { contextFor } from '../../../packages/db/src/auth.ts';
import { SOURCE_CATALOG } from '../../../packages/connectors/src/catalog.ts';
import { allowedHosts, ConnectorError, fetchGuarded, guardUrl } from '../../../packages/connectors/src/http.ts';

const probe = process.argv.includes('--probe');
const login = process.env['INGESTION_LOGIN'] ?? 'gestor.demo';
const tenantSlug = process.env['DEFAULT_TENANT_SLUG'] ?? 'demonstracao';

const context = await contextFor(login, tenantSlug);
const hosts = allowedHosts();

if (hosts.length === 0) {
  console.error(
    'INGESTION_ALLOWED_HOSTS esta vazio: nenhuma coleta externa autorizada.\n' +
      'Defina a allowlist antes de coletar. Ver docs/runbooks/coleta.md.',
  );
}

interface ProbeResult {
  readonly code: string;
  readonly url: string;
  readonly outcome: 'ok' | 'blocked_by_policy' | 'guard_refused' | 'auth_or_policy' | 'error';
  readonly detail: string;
}

async function probeSource(spec: (typeof SOURCE_CATALOG)[number]): Promise<ProbeResult> {
  // Sondar o dominio do endpoint, nao o da pagina de documentacao.
  const url = spec.probeUrl ?? spec.url;
  const guard = await guardUrl(url, hosts);
  if (!guard.ok) {
    return { code: spec.code, url, outcome: 'guard_refused', detail: guard.reason };
  }
  try {
    const result = await fetchGuarded(url, { maxRetries: 1, maxBytes: 2 * 1024 * 1024 });
    return {
      code: spec.code,
      url,
      outcome: 'ok',
      detail: `HTTP ${result.status}, ${result.body.byteLength} bytes, tipo ${result.contentType ?? 'nao declarado'}`,
    };
  } catch (error) {
    if (error instanceof ConnectorError) {
      // Um 401/403 aqui e AMBIGUO: pode ser o portal exigindo credencial ou a
      // politica de egresso do proprio ambiente recusando o destino. Nao
      // adivinhamos: devolvemos 'auth_or_policy' e a mensagem diz que a
      // distincao precisa ser verificada (§1.2, nao simular execucao).
      return {
        code: spec.code,
        url,
        outcome:
          error.kind === 'auth_failed'
            ? 'auth_or_policy'
            : error.kind === 'host_not_allowed' || error.kind === 'blocked_address'
              ? 'blocked_by_policy'
              : 'error',
        detail:
          error.kind === 'auth_failed'
            ? `${error.message} - pode ser credencial exigida pelo portal OU bloqueio de egresso do ambiente; verifique antes de concluir`
            : `${error.kind}: ${error.message}`,
      };
    }
    return { code: spec.code, url, outcome: 'error', detail: (error as Error).message };
  }
}

if (probe) {
  console.log(`Prova de acesso as ${SOURCE_CATALOG.length} fontes do catalogo.`);
  console.log(`Allowlist: ${hosts.length === 0 ? '(vazia)' : hosts.join(', ')}\n`);

  const results: ProbeResult[] = [];
  for (const spec of SOURCE_CATALOG) {
    const result = await probeSource(spec);
    results.push(result);
    console.log(`${result.code}  ${result.outcome.padEnd(18)} ${result.detail}`);
  }

  // O resultado da sonda e auditoria, nao promocao de integracao. Nenhum
  // integration_status muda aqui: isso e decisao de operacao autorizada apos o
  // checklist F.1 (ver docs/runbooks/coleta.md).
  await withContext(context, async (db) => {
    for (const result of results) {
      await db.query(
        `insert into ma.audit_log (tenant_id, actor, action, object_kind, object_id, detail)
         values ($1, 'ingestion-probe', 'access_probe', 'source', $2, $3)`,
        [context.tenantId, result.code, JSON.stringify(result)],
      );
    }
  });

  const alcancadas = results.filter((r) => r.outcome === 'ok').length;
  console.log(`\n${alcancadas} de ${results.length} fonte(s) alcancada(s).`);
  if (alcancadas === 0) {
    console.log(
      'Nenhuma fonte alcancada. Se a causa for a politica de egresso do ambiente,\n' +
        'isso e um bloqueio a reportar, nao a contornar. Ver docs/sources/prova-de-acesso.md.',
    );
  }
  console.log('\nNenhum integration_status foi alterado: alcançar uma fonte nao e integra-la (§F.1).');
  await closePool();
} else {
  const habilitadas = await withContext(context, async (db) => {
    const r = await db.query<{ code: string; name: string }>(
      `select s.code, sd.name
         from ma.sources s join ma.source_datasets sd on sd.source_id = s.id
        where s.enabled and s.integration_status = 'connector_verified'
        order by s.code, sd.name`,
    );
    return r.rows;
  });

  if (habilitadas.length === 0) {
    console.log(
      'Nenhuma fonte habilitada e verificada. Nada a coletar.\n\n' +
        'Isto e o estado esperado desta entrega: nenhum conector foi validado contra\n' +
        'dados reais porque o acesso as fontes esta bloqueado (docs/sources/prova-de-acesso.md).\n' +
        'Para provar acesso:  npm run ingest -- --probe\n' +
        'Para habilitar uma fonte, siga o checklist F.1 em docs/runbooks/coleta.md.',
    );
    await closePool();
    process.exit(0);
  }

  console.log(`${habilitadas.length} conjunto(s) habilitado(s) e verificado(s):`);
  for (const row of habilitadas) console.log(`  ${row.code}/${row.name}`);
  console.log(
    '\nNenhum conector de extracao esta implementado nesta entrega (decisao D12).\n' +
      'O transporte, o pipeline e a matriz de cobertura estao prontos e testados;\n' +
      'falta o parser por fonte, que depende de amostra real.',
  );
  await closePool();
}
