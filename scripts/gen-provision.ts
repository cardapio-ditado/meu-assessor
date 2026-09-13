/**
 * Gera db/bootstrap/03-provision.sql a partir de
 * packages/connectors/src/catalog.ts, que e a fonte de verdade do catalogo de
 * fontes.
 *
 * Existe para que a situacao de integracao de cada fonte nao divirja entre o
 * codigo e o SQL de provisionamento. Transcrever nove fontes a mao foi como o
 * primeiro provisionamento foi feito, e e exatamente onde uma fonte passaria a
 * constar como "conector verificado" por engano.
 *
 * Uso:
 *   node --experimental-strip-types scripts/gen-provision.ts > db/bootstrap/03-provision.sql
 */
import { SOURCE_CATALOG } from '../packages/connectors/src/catalog.ts';

/** Literal SQL com escape de apostrofo. */
function lit(value: string | null): string {
  if (value === null) return 'null';
  return `'${value.replace(/'/g, "''")}'`;
}

function textArray(values: readonly string[]): string {
  return `array[${values.map(lit).join(',')}]::text[]`;
}

const sources = SOURCE_CATALOG.map(
  (s) =>
    `      (${lit(s.code)}, ${lit(s.officialName)}, ${lit(s.domain)}, ${lit(s.organ)}, ` +
    `${lit(s.sphere)}, ${textArray(s.recordTypes)}, ${lit(s.accessMethod)}, ` +
    `${s.requiresCredentials}, ${textArray(s.knownLimitations)}, ${lit(s.integrationStatus)})`,
).join(',\n');

const datasets = SOURCE_CATALOG.flatMap((s) =>
  s.datasets.map(
    (d) =>
      `    (${lit(s.code)}, ${lit(d.name)}, ${lit(d.recordType)}, ` +
      `${lit(d.cadence)}, ${d.staleAfterHours})`,
  ),
).join(',\n');

// Guarda contra o erro que este gerador existe para evitar.
const verified = SOURCE_CATALOG.filter((s) => s.integrationStatus === 'connector_verified');
if (verified.length > 0) {
  console.error(
    `ERRO: ${verified.map((s) => s.code).join(', ')} esta marcada como conector verificado ` +
      'no catalogo. Nenhuma fonte foi verificada contra dados reais (ver ' +
      'docs/sources/prova-de-acesso.md). Corrija o catalogo antes de gerar o provisionamento.',
  );
  process.exit(1);
}

process.stdout.write(`-- 03-provision.sql — organizacao do piloto e catalogo de fontes.
--
-- ARQUIVO GERADO. Nao edite a mao: a fonte de verdade e
-- packages/connectors/src/catalog.ts. Para regerar:
--   node --experimental-strip-types scripts/gen-provision.ts > db/bootstrap/03-provision.sql
--
-- Deliberadamente SEM dado sintetico. Consequencia esperada e correta: a
-- aplicacao abre com feed vazio e o aviso de que nenhum conector esta em
-- operacao. Isso nao e falha de implantacao; e a unica coisa verdadeira que
-- ela pode dizer antes de a etapa E1 ser cumprida (14.2, 28.2).
--
-- Idempotente: aplicar duas vezes nao duplica nada.
set search_path to ma, public, extensions;

insert into ma.municipalities (name, uf, time_zone, primary_cnpj)
values ('Varzea Grande', 'MT', 'America/Cuiaba', '03.507.548/0001-10')
on conflict (name, uf) do update set time_zone = excluded.time_zone;

insert into ma.tenants (slug, display_name)
values ('varzea-grande', 'Prefeitura de Varzea Grande - piloto Meu Assessor')
on conflict (slug) do update set display_name = excluded.display_name;

-- UMA conta de implantacao. As contas dos usuarios do piloto sao criadas pelo
-- administrador municipal: o briefing 1.3 exige autorizacao antes de criar
-- contas em nome de terceiros.
insert into ma.users (login, display_name, job_title)
values ('admin.implantacao', 'Administracao da implantacao', 'Implantacao e curadoria')
on conflict (login) do update set display_name = excluded.display_name;

insert into ma.tenant_municipalities (tenant_id, municipality_id)
select t.id, mu.id
  from ma.tenants t, ma.municipalities mu
 where t.slug = 'varzea-grande' and mu.name = 'Varzea Grande' and mu.uf = 'MT'
on conflict do nothing;

insert into ma.user_grants (user_id, tenant_id, role, access_classes)
select u.id, t.id, r.role, array['public','internal_authorized']::ma.access_class[]
  from ma.users u, ma.tenants t,
       (values ('municipal_admin'), ('data_curator'), ('manager')) as r(role)
 where u.login = 'admin.implantacao' and t.slug = 'varzea-grande'
on conflict (user_id, tenant_id, role) do nothing;

-- Catalogo de fontes. NENHUMA habilitada (8.1, C.2): a situacao de integracao
-- diz a verdade — pagina localizada, acesso sondado ou bloqueado, nunca
-- conector verificado.
insert into ma.sources
  (tenant_id, code, official_name, domain, organ, sphere, record_types,
   access_method, requires_credentials, known_limitations, integration_status,
   operational_owner, connector_version, desired_frequency, access_class, enabled)
select t.id, x.code, x.official_name, x.domain, x.organ, x.sphere, x.record_types,
       x.access_method, x.requires_credentials, x.known_limitations, x.integration_status,
       'operacao-nao-designada', '0.1.0', 'duas janelas diarias', 'public', false
  from ma.tenants t,
  (values
${sources}
  ) as x(code, official_name, domain, organ, sphere, record_types, access_method,
         requires_credentials, known_limitations, integration_status)
 where t.slug = 'varzea-grande'
on conflict (tenant_id, code) do update
   set official_name = excluded.official_name,
       integration_status = excluded.integration_status,
       known_limitations = excluded.known_limitations;

insert into ma.source_datasets (tenant_id, source_id, name, record_type, cadence, stale_after_hours)
select s.tenant_id, s.id, d.name, d.record_type, d.cadence, d.stale_after_hours
  from ma.sources s
  join ma.tenants t on t.id = s.tenant_id and t.slug = 'varzea-grande'
  join (values
${datasets}
  ) as d(code, name, record_type, cadence, stale_after_hours) on d.code = s.code
on conflict (source_id, name) do update set cadence = excluded.cadence;
`);
