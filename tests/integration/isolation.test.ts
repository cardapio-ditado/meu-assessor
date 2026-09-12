/**
 * Isolamento entre organizacoes, contra o banco de verdade.
 *
 * Briefing 20.3 / F17: "Usar papel de aplicacao sem privilegios de bypass e
 * TESTAR as politicas, em vez de presumir que ativar RLS resolve todo o
 * isolamento."
 *
 * Cobre T32 (usuario altera o ID do documento na URL), T33 (mesma pergunta em
 * duas prefeituras) e o criterio de aceite "Isolamento" do 22.2.
 *
 * Requer o banco carregado: npm run db:migrate && npm run db:seed -- --reset
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withContext, withLogin, withoutTenant } from '../../packages/db/src/pool.ts';
import { contextFor } from '../../packages/db/src/auth.ts';
import { getEntity, getEvidence } from '../../packages/db/src/repository.ts';
import { searchEntities } from '../../packages/retrieval/src/search.ts';
import { ask } from '../../packages/answer/src/engine.ts';
import type { AuthorizedContext } from '../../packages/domain/src/types.ts';

const skip = process.env['DATABASE_URL'] === undefined ? 'DATABASE_URL nao definida' : false;

let gabinete: AuthorizedContext;
let vizinho: AuthorizedContext;

describe('isolamento entre organizacoes', { skip }, () => {
  before(async () => {
    gabinete = await contextFor('gestor.demo', 'demonstracao');
    vizinho = await contextFor('gestor.vizinho', 'demonstracao-vizinha');
    assert.notEqual(gabinete.tenantId, vizinho.tenantId);
    assert.notEqual(gabinete.municipalityId, vizinho.municipalityId);
  });

  after(async () => {
    await closePool();
  });

  test('o papel da aplicacao nao tem privilegio de contornar RLS', async () => {
    const row = await withoutTenant(async (db) => {
      const r = await db.query<{ rolbypassrls: boolean; rolsuper: boolean; current: string }>(
        `select rolbypassrls, rolsuper, current_user as current
           from pg_roles where rolname = current_user`,
      );
      return r.rows[0];
    });
    assert.equal(row?.rolbypassrls, false, 'BYPASSRLS tornaria todo o isolamento decorativo');
    assert.equal(row?.rolsuper, false);
  });

  test('as tabelas de conteudo tem RLS FORCADO, nao apenas habilitado', async () => {
    const rows = await withoutTenant(async (db) => {
      const r = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'ma' and c.relkind = 'r'
            and c.relname in ('claims','evidence','document_versions','entities',
                              'financial_events','person_relations','answers','answer_cache')`,
      );
      return r.rows;
    });
    assert.ok(rows.length >= 8);
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} sem RLS`);
      // Sem FORCE, a politica nao valeria para o dono da tabela.
      assert.equal(row.relforcerowsecurity, true, `${row.relname} sem FORCE RLS`);
    }
  });

  test('sem contexto de organizacao, nao se le conteudo nenhum', async () => {
    const counts = await withoutTenant(async (db) => {
      const r = await db.query<{ claims: string; docs: string; evidence: string }>(
        `select (select count(*) from ma.claims)::text as claims,
                (select count(*) from ma.document_versions)::text as docs,
                (select count(*) from ma.evidence)::text as evidence`,
      );
      return r.rows[0];
    });
    assert.equal(counts?.claims, '0');
    assert.equal(counts?.docs, '0');
    assert.equal(counts?.evidence, '0');
  });

  test('T32 - trocar o ID na URL nao alcanca objeto de outra organizacao', async () => {
    // Pega um id real do vizinho...
    const idDoVizinho = await withContext(vizinho, async (db) => {
      const candidates = await searchEntities(db, vizinho, 'quadra poliesportiva', { limit: 5 });
      assert.ok(candidates.length > 0, 'o vizinho precisa ter ao menos um assunto');
      return candidates[0]!.id;
    });

    // ...e tenta abrir com a sessao do outro gabinete.
    const visto = await withContext(gabinete, (db) => getEntity(db, idDoVizinho));
    assert.equal(visto, null, 'o objeto de outra organizacao nao pode ser legivel');
  });

  test('evidencia de outra organizacao nao e recuperavel nem por id exato', async () => {
    const idEvidencia = await withContext(vizinho, async (db) => {
      const r = await db.query<{ id: string }>(`select id from ma.evidence limit 1`);
      return r.rows[0]?.id ?? null;
    });
    assert.notEqual(idEvidencia, null);
    const encontrada = await withContext(gabinete, (db) => getEvidence(db, [idEvidencia as string]));
    assert.equal(encontrada.size, 0);
  });

  test('T33 - a mesma pergunta em duas organizacoes nao cruza acervo nem cache', async () => {
    const pergunta = 'Como esta a quadra poliesportiva do Bairro Exemplo?';

    const aqui = await withContext(gabinete, (db) => ask(db, gabinete, pergunta));
    const la = await withContext(vizinho, (db) => ask(db, vizinho, pergunta));

    // A chave de cache carrega organizacao e acesso (16.3): nunca coincide.
    assert.notEqual(aqui.cacheKey, la.cacheKey);

    // Nenhuma evidencia aparece nas duas respostas.
    const evidenciasAqui = new Set(aqui.envelope.layers.prove);
    for (const id of la.envelope.layers.prove) {
      assert.ok(!evidenciasAqui.has(id), 'evidencia compartilhada entre organizacoes');
    }
    assert.notEqual(aqui.envelope.context.municipality, la.envelope.context.municipality);
  });

  test('a busca de uma organizacao nao devolve entidade da outra', async () => {
    const nomesAqui = await withContext(gabinete, async (db) =>
      (await searchEntities(db, gabinete, 'quadra', { limit: 50 })).map((c) => c.officialName),
    );
    assert.ok(nomesAqui.length > 0);
    assert.ok(
      !nomesAqui.some((n) => n.includes('vizinha')),
      'o acervo do municipio vizinho apareceu na busca',
    );
  });

  test('escrever com tenant_id de outra organizacao e recusado pelo banco', async () => {
    await assert.rejects(
      withContext(gabinete, async (db) => {
        await db.query(
          `insert into ma.localities (tenant_id, municipality_id, official_name)
           values ($1, $2, 'tentativa indevida')`,
          [vizinho.tenantId, vizinho.municipalityId],
        );
      }),
      /row-level security|violates/i,
    );
  });

  test('a sessao le apenas as classes de acesso que seus grants concedem', async () => {
    // O gestor da demonstracao tem public e internal_authorized, nao restricted.
    assert.ok(gabinete.accessClasses.includes('public'));
    assert.ok(!gabinete.accessClasses.includes('restricted'));

    // Um registro restrito criado pela curadoria nao aparece para quem nao tem
    // a classe. Criamos com uma sessao que tem a classe e lemos com uma que nao.
    const comRestrito: AuthorizedContext = { ...gabinete, accessClasses: [...gabinete.accessClasses, 'restricted'] };
    const criado = await withContext(comRestrito, async (db) => {
      const r = await db.query<{ id: string }>(
        `insert into ma.localities (tenant_id, municipality_id, official_name, access_class)
         values ($1, $2, 'Localidade restrita de teste', 'restricted') returning id`,
        [gabinete.tenantId, gabinete.municipalityId],
      );
      return r.rows[0]!.id;
    });

    try {
      // localities nao esta na lista de tabelas com filtro de classe; o teste
      // real e sobre as tabelas de conteudo. Fazemos o mesmo com uma entidade.
      const entidadeRestrita = await withContext(comRestrito, async (db) => {
        const r = await db.query<{ id: string }>(
          `insert into ma.entities
             (tenant_id, municipality_id, kind, official_name, name_normalized, access_class, is_synthetic)
           values ($1,$2,'subject','Assunto restrito de teste','assunto restrito de teste','restricted',true)
           returning id`,
          [gabinete.tenantId, gabinete.municipalityId],
        );
        return r.rows[0]!.id;
      });

      const visivelParaGestor = await withContext(gabinete, (db) => getEntity(db, entidadeRestrita));
      assert.equal(visivelParaGestor, null, 'classe restricted ficou legivel sem o grant');

      const visivelParaCurador = await withContext(comRestrito, (db) => getEntity(db, entidadeRestrita));
      assert.notEqual(visivelParaCurador, null);

      await withContext(comRestrito, (db) =>
        db.query(`delete from ma.entities where id = $1`, [entidadeRestrita]),
      );
    } finally {
      await withContext(comRestrito, (db) =>
        db.query(`delete from ma.localities where id = $1`, [criado]),
      );
    }
  });
});

/**
 * O caminho de autenticacao da migracao 0006 substituiu uma funcao
 * SECURITY DEFINER com BYPASSRLS por uma politica de RLS. Essa troca precisa
 * ser provada, nao assumida: a politica vale apenas sem organizacao no
 * contexto e devolve exclusivamente as concessoes do login autenticado.
 */
describe('caminho de autenticacao sem privilegio', { skip }, () => {
  before(async () => {
    gabinete = await contextFor('gestor.demo', 'demonstracao');
    vizinho = await contextFor('gestor.vizinho', 'demonstracao-vizinha');
  });

  after(async () => {
    await closePool();
  });

  test('nao existe funcao SECURITY DEFINER no esquema', async () => {
    const n = await withoutTenant(async (db) => {
      const r = await db.query<{ n: string }>(
        `select count(*)::text as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'ma' and p.prosecdef`,
      );
      return r.rows[0]?.n;
    });
    assert.equal(n, '0', 'uma funcao definer reintroduz excecao de privilegio');
  });

  test('nenhum papel do produto tem BYPASSRLS', async () => {
    const rows = await withoutTenant(async (db) => {
      const r = await db.query<{ rolname: string; rolbypassrls: boolean }>(
        `select rolname, rolbypassrls from pg_roles where rolname like 'meu_assessor%'`,
      );
      return r.rows;
    });
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.rolbypassrls, false, `${row.rolname} tem BYPASSRLS`);
    }
  });

  test('o login resolve apenas as proprias concessoes', async () => {
    const proprias = await withLogin('gestor.demo', async (db) => {
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ma.user_grants`);
      return Number(r.rows[0]?.n ?? '0');
    });
    // gestor.demo tem exatamente um grant (manager na organizacao de demonstracao).
    assert.equal(proprias, 1);

    // O curador tem grant na MESMA organizacao. Ainda assim nao aparece para
    // o login do gestor: a politica filtra por usuario, nao por organizacao.
    const doCurador = await withLogin('curador.demo', async (db) => {
      const r = await db.query<{ role: string }>(`select role from ma.user_grants`);
      return r.rows.map((x) => x.role);
    });
    assert.deepEqual(doCurador, ['data_curator']);
  });

  test('sem ma.login definido, o caminho nao devolve concessao nenhuma', async () => {
    const n = await withoutTenant(async (db) => {
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ma.user_grants`);
      return r.rows[0]?.n;
    });
    assert.equal(n, '0');
  });

  test('login inexistente nao devolve concessao, e nao se distingue de sem acesso', async () => {
    const n = await withLogin('nao.existe', async (db) => {
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ma.user_grants`);
      return r.rows[0]?.n;
    });
    assert.equal(n, '0');
    await assert.rejects(() => contextFor('nao.existe', 'demonstracao'), /acesso nao disponivel/);
    // A mesma mensagem para usuario existente sem acesso aquela organizacao.
    await assert.rejects(() => contextFor('gestor.demo', 'demonstracao-vizinha'), /acesso nao disponivel/);
  });

  test('a politica de autenticacao NAO abre conteudo: so concessoes', async () => {
    const counts = await withLogin('gestor.demo', async (db) => {
      const r = await db.query<{ claims: string; docs: string; evidence: string; entities: string }>(
        `select (select count(*) from ma.claims)::text as claims,
                (select count(*) from ma.document_versions)::text as docs,
                (select count(*) from ma.evidence)::text as evidence,
                (select count(*) from ma.entities)::text as entities`,
      );
      return r.rows[0];
    });
    assert.equal(counts?.claims, '0');
    assert.equal(counts?.docs, '0');
    assert.equal(counts?.evidence, '0');
    assert.equal(counts?.entities, '0');
  });

  test('com organizacao no contexto, a politica de autenticacao fica inerte', async () => {
    // Mesmo gravando ma.login junto, o ramo auth_path exige tenant nulo. Uma
    // sessao de organizacao nao ganha leitura ampliada de concessoes.
    const visiveis = await withContext(gabinete, async (db) => {
      await db.query('select set_config($1, $2, true)', ['ma.login', 'curador.demo']);
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ma.user_grants`);
      return Number(r.rows[0]?.n ?? '0');
    });
    // Ve as concessoes da propria organizacao (gestor + curador = 2), nunca as
    // da organizacao vizinha.
    assert.equal(visiveis, 2);

    const doVizinho = await withContext(vizinho, async (db) => {
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ma.user_grants`);
      return Number(r.rows[0]?.n ?? '0');
    });
    assert.equal(doVizinho, 1);
  });
});
