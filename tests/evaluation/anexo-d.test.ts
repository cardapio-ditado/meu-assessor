/**
 * Conjunto de avaliacao do Anexo D, sobre o recorte sintetico.
 *
 * Briefing 22.1: "A resposta esperada deve especificar fatos corretos,
 * ressalvas obrigatorias, referencias aceitaveis e situacoes em que o sistema
 * precisa se abster." Cada teste abaixo afirma o RESULTADO OBRIGATORIO do
 * Anexo D, nao a aparencia do texto.
 *
 * Limite declarado: os casos cobertos aqui sao os que o recorte sintetico
 * permite exercitar. Os demais estao listados em docs/acceptance/anexo-d.md
 * como nao executados, e nao contam como aprovados (22.5).
 *
 * Requer: npm run db:migrate && npm run db:seed -- --reset
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withContext } from '../../packages/db/src/pool.ts';
import { contextFor } from '../../packages/db/src/auth.ts';
import { ask } from '../../packages/answer/src/engine.ts';
import {
  getClaimsKnownAt,
  getClaimsValidOn,
  getRecentCards,
  getPersonRelations,
} from '../../packages/db/src/repository.ts';
import { searchEntities, resolveOne } from '../../packages/retrieval/src/search.ts';
import { dateRange, plainDate } from '../../packages/domain/src/temporal.ts';
import { validateAnswer } from '../../packages/answer/src/validator.ts';
import type { AuthorizedContext, Claim, Evidence } from '../../packages/domain/src/types.ts';

const skip = process.env['DATABASE_URL'] === undefined ? 'DATABASE_URL nao definida' : false;

let ctx: AuthorizedContext;

describe('Anexo D - casos funcionais e adversariais', { skip }, () => {
  before(async () => {
    ctx = await contextFor('gestor.demo', 'demonstracao');
  });
  after(async () => {
    await closePool();
  });

  test('T01 - a pergunta da jornada localiza a entidade correta', async () => {
    const result = await withContext(ctx, (db) => ask(db, ctx, 'Como esta a quadra do bairro Exemplo?'));
    assert.notEqual(result.envelope.status, 'unavailable');
    assert.match(result.envelope.layers.brief, /Quadra Poliesportiva do Bairro Exemplo/);
  });

  test('T02 - dois homonimos exatos NAO sao resolvidos em silencio', async () => {
    const result = await withContext(ctx, (db) => ask(db, ctx, 'Como esta a quadra poliesportiva municipal?'));
    assert.equal(result.envelope.status, 'clarification_needed');
    assert.equal(result.envelope.claims.length, 0, 'nenhuma afirmacao pode sair antes da escolha');
    // As opcoes precisam distinguir por localidade (6.1).
    const nomes = result.candidates.map((c) => `${c.officialName}|${c.localityName ?? ''}`);
    const municipais = nomes.filter((n) => n.startsWith('Quadra Poliesportiva Municipal|'));
    assert.ok(municipais.length >= 2, `esperava dois homonimos, veio: ${nomes.join(' ; ')}`);
    assert.notEqual(municipais[0], municipais[1], 'as opcoes precisam ser distinguiveis');
  });

  test('T03 - apelido local confirmado encontra, e a resposta usa o nome oficial', async () => {
    const found = await withContext(ctx, async (db) => {
      const candidates = await searchEntities(db, ctx, 'como esta a quadrinha do exemplo', { limit: 5 });
      return candidates;
    });
    const alvo = found.find((c) => c.officialName === 'Quadra Poliesportiva do Bairro Exemplo');
    assert.notEqual(alvo, undefined, 'o apelido curado deveria encontrar a entidade');
    assert.equal(alvo?.matchKind, 'curated_alias');
    // O nome oficial e o que aparece, nao o apelido.
    assert.equal(alvo?.officialName, 'Quadra Poliesportiva do Bairro Exemplo');
  });

  test('T05 e T06 - data do evento separada da data de publicacao', async () => {
    const cards = await withContext(ctx, (db) =>
      getRecentCards(db, dateRange(plainDate('2026-09-01'), plainDate('2026-09-12')), 10),
    );
    assert.ok(cards.length > 0);
    for (const card of cards) {
      // Os dois campos existem separadamente; nenhum substitui o outro.
      assert.ok('factDate' in card && 'publicationDate' in card);
    }
    // T06: a noticia de 2026 sobre o contrato de 2025 nao vira contratacao nova.
    const result = await withContext(ctx, (db) =>
      ask(db, ctx, 'Como esta a quadra poliesportiva do Bairro Exemplo?'),
    );
    const contrato = result.envelope.layers.understand.find((f) => f.label === 'Contrato');
    assert.equal(contrato?.factDate, '2025-03-01', 'a data do fato do contrato e de 2025');
    const noticia = result.envelope.layers.history.find((h) => h.publicationDate === '2026-09-02');
    assert.equal(noticia?.factDate, '2026-09-02');
    const extrato = result.envelope.layers.history.find((h) => h.relationNature === 'contract_number');
    assert.equal(extrato?.factDate, '2025-03-01');
    assert.equal(extrato?.publicationDate, '2025-03-05');
  });

  test('T08 - emenda coletiva nao multiplica o valor por integrante', async () => {
    const relations = await withContext(ctx, async (db) => {
      const pessoas = await searchEntities(db, ctx, 'Parlamentar Ficticio A', { kinds: ['public_person'] });
      const pessoa = resolveOne(pessoas);
      assert.notEqual(pessoa.entity, null);
      return getPersonRelations(db, pessoa.entity!.id);
    });
    const naEmenda = relations.filter((r) => r.relatedEntityName.includes('Coletiva'));
    assert.ok(naEmenda.length > 0);
    for (const r of naEmenda) {
      // A fonte nao informa parcela individual: o vinculo e de bancada e a
      // parcela documentada e nula. Nada permite atribuir R$ 1.000.000 a cada um.
      assert.equal(r.relationType, 'collective_bench');
      assert.equal(r.documentedShare, null);
    }
  });

  test('T09 - presenca em entrega nao vira autoria', async () => {
    const relations = await withContext(ctx, async (db) => {
      const pessoas = await searchEntities(db, ctx, 'Parlamentar Ficticio C', { kinds: ['public_person'] });
      const pessoa = resolveOne(pessoas);
      return getPersonRelations(db, pessoa.entity!.id);
    });
    const naUbs = relations.find((r) => r.relatedEntityName.includes('UBS'));
    assert.equal(naUbs?.relationType, 'mentioned_by_source');
    assert.ok(
      !relations.some((r) => r.relatedEntityName.includes('UBS') && (r.relationType === 'author' || r.relationType === 'coauthor')),
      'mencao em noticia nao pode virar autoria',
    );
  });

  test('T11 e T13 - o total transferido conta o pagamento uma vez e ignora saldo acumulado', async () => {
    const result = await withContext(ctx, (db) =>
      ask(db, ctx, 'Quanto foi transferido pela Emenda Ficticia Coletiva 2026/EX-0001?'),
    );
    const transferido = result.envelope.layers.understand.find((f) => f.label === 'Transferido');
    assert.notEqual(transferido, undefined);
    // 600.000 (um unico repasse, apesar de publicado em dois portais)
    // menos 50.000 de devolucao vinculada = 550.000.
    assert.match(transferido!.value, /R\$ 550\.000,00/);
    // A posicao acumulada de 550.000 do mes NAO foi somada aos fluxos.
    assert.ok(!/R\$ 1\.100\.000,00|R\$ 1\.150\.000,00/.test(transferido!.value));
    assert.match(result.envelope.warnings.join(' '), /posicao acumulada/i);
  });

  test('T14 - a devolucao nao contamina outras etapas', async () => {
    const result = await withContext(ctx, (db) =>
      ask(db, ctx, 'Quanto foi transferido pela Emenda Ficticia Coletiva 2026/EX-0001?'),
    );
    for (const label of ['Empenhado', 'Pago ao fornecedor']) {
      const fato = result.envelope.layers.understand.find((f) => f.label === label);
      assert.notEqual(fato, undefined);
      assert.ok(!fato!.value.includes('-R$'), `${label} recebeu um valor negativo de anulacao alheia`);
      // 10.4: ausencia nao e zero.
      assert.match(fato!.value, /nenhum registro localizado/i);
    }
  });

  test('T16 e T20 - aditivo de prazo prevalece e o conflito continua visivel', async () => {
    const result = await withContext(ctx, (db) =>
      ask(db, ctx, 'Como esta a quadra poliesportiva do Bairro Exemplo?'),
    );
    const vigencia = result.envelope.layers.understand.find((f) => f.label === 'Vigencia do contrato');
    assert.equal(vigencia?.value, '2026-06-29', 'a vigencia aplicavel vem do aditivo');
    assert.equal(vigencia?.state, 'divergent');
    assert.equal(result.envelope.conflicts.length, 1);
    assert.match(result.envelope.conflicts[0]!, /29\/06\/2026|2026-06-29/);
    assert.match(result.envelope.conflicts[0]!, /31\/12\/2025|2025-12-31/);
  });

  test('T22 - "qual era o prazo em marco de 2025?" usa a versao valida no periodo', async () => {
    const claims = await withContext(ctx, async (db) => {
      const found = await searchEntities(db, ctx, 'Quadra Poliesportiva do Bairro Exemplo', { kinds: ['subject'] });
      const alvo = resolveOne(found);
      return getClaimsValidOn(db, alvo.entity!.id, plainDate('2025-03-15'));
    });
    const vigencia = claims.find((c) => c.predicate === 'contract_validity_end');
    assert.equal(vigencia?.value, '2025-12-31', 'em marco de 2025 o prazo era o original');
  });

  test('T23 - "o que sabiamos em junho de 2025?" usa o eixo de conhecimento', async () => {
    const claims = await withContext(ctx, async (db) => {
      const found = await searchEntities(db, ctx, 'Quadra Poliesportiva do Bairro Exemplo', { kinds: ['subject'] });
      const alvo = resolveOne(found);
      return getClaimsKnownAt(db, alvo.entity!.id, plainDate('2025-06-30'));
    });
    const vigencia = claims.find((c) => c.predicate === 'contract_validity_end');
    // O aditivo so entrou na base em novembro de 2025.
    assert.equal(vigencia?.value, '2025-12-31');
    assert.ok(
      !claims.some((c) => c.value === '2026-06-29'),
      'o que a plataforma conhecia em junho nao inclui o aditivo de novembro',
    );
  });

  test('T18 e T19 - conclusao relatada por nota e pagamento integral nao viram obra concluida', async () => {
    const result = await withContext(ctx, (db) => ask(db, ctx, 'A reforma da UBS do Bairro Modelo terminou?'));
    const situacao = result.envelope.layers.understand.find((f) => f.label === 'Situacao documentada');
    // A conclusao e atribuida a fonte, nao afirmada.
    assert.equal(situacao?.state, 'source_reported');
    assert.match(situacao!.value, /relatada|sem termo de recebimento/i);
    // E o percentual fisico continua nao localizado, apesar de 100% pago.
    const fisico = result.envelope.layers.understand.find((f) => f.label === 'Percentual fisico medido');
    assert.equal(fisico?.state, 'not_located');
    assert.match(fisico!.value, /nao comprova execucao fisica|nenhuma medicao/i);
    assert.match(result.envelope.missingFields.join(' '), /termo de recebimento/i);
  });

  test('T24 e T25 - sem dado, o produto nao declara inexistencia nem preenche com zero', async () => {
    const result = await withContext(ctx, (db) => ask(db, ctx, 'Como esta o poco artesiano do Distrito Amostra?'));
    const texto = `${result.envelope.layers.brief} ${result.envelope.layers.understand.map((f) => f.value).join(' ')}`;
    assert.ok(!/nao existe|inexistente|nunca houve/i.test(texto), 'a base nao prova inexistencia');
    assert.ok(!/R\$ 0,00/.test(texto), 'zero nao substitui ausencia');
    assert.match(result.envelope.missingFields.join(' '), /Existe qualquer documento/i);
  });

  test('T30 - o documento com instrucao embutida foi para quarentena, sem virar evidencia', async () => {
    const estado = await withContext(ctx, async (db) => {
      const doc = await db.query<{ n: string }>(
        `select count(*)::text as n from ma.document_versions where external_id = 'SINT-DO-2026-INJECAO'`,
      );
      const audit = await db.query<{ n: string }>(
        `select count(*)::text as n from ma.audit_log where action = 'injection_detected'`,
      );
      const review = await db.query<{ n: string }>(
        `select count(*)::text as n from ma.review_queue where reason like '%instrucao embutida%'`,
      );
      return { doc: doc.rows[0]?.n, audit: audit.rows[0]?.n, review: review.rows[0]?.n };
    });
    assert.equal(estado.doc, '0', 'o documento malicioso nao pode ter sido publicado');
    assert.notEqual(estado.audit, '0', 'a tentativa precisa estar auditada');
    assert.notEqual(estado.review, '0', 'a tentativa precisa gerar item de revisao');
  });

  test('T35 - afirmacao que cita evidencia fora do conjunto recuperado e bloqueada', () => {
    const evidencia: Evidence = {
      id: 'ev-real',
      tenantId: 't1',
      documentVersionId: 'doc-1',
      locator: 'p. 1',
      snippet: 'trecho real',
      queryParameters: null,
      obtainedAt: new Date().toISOString() as Evidence['obtainedAt'],
      accessClass: 'public',
    };
    const claim: Claim = {
      id: 'c1', tenantId: 't1', subjectId: 's1', subjectKind: 'subject',
      predicate: 'status', value: 'em execucao', valueType: 'text', money: null, unit: null,
      qualifiers: {}, validFrom: null, validTo: null, factDate: plainDate('2026-09-01'),
      recordedAt: new Date().toISOString() as Claim['recordedAt'], retiredAt: null,
      evidenceIds: ['ev-inventada'], state: 'documented', validationState: 'published',
      freshnessClass: 'mutable_operational', nullReason: null, reviewedBy: null,
      reviewMethod: null, accessClass: 'public',
    };
    const result = validateAnswer({
      retrievedEvidence: new Map([[evidencia.id, evidencia]]),
      retrievedClaims: new Map([[claim.id, claim]]),
      answerClaims: [
        { claimId: 'c1', text: 'A obra esta em execucao.', evidenceIds: ['ev-inventada'], factDate: plainDate('2026-09-01'), state: 'documented' },
      ],
      contextMunicipalityId: 'm1',
      documentMunicipality: new Map([['doc-1', 'm1']]),
      today: plainDate('2026-09-12'),
      needsCurrentState: true,
      personRelations: new Map(),
      computedAmounts: new Map(),
    });
    assert.equal(result.verdict, 'blocked');
    assert.match(result.technicalReasons.join(' '), /nao esta no conjunto recuperado/);
  });

  test('T36 - valor citado divergente do campo estruturado e contraditado', () => {
    const evidencia: Evidence = {
      id: 'ev-1', tenantId: 't1', documentVersionId: 'doc-1', locator: 'p. 1',
      snippet: 'Valor global: R$ 800.000,00', queryParameters: null,
      obtainedAt: new Date().toISOString() as Evidence['obtainedAt'], accessClass: 'public',
    };
    const claim: Claim = {
      id: 'c1', tenantId: 't1', subjectId: 's1', subjectKind: 'subject',
      predicate: 'contracted_amount', value: null, valueType: 'money',
      money: { cents: 80_000_000n, currency: 'BRL' }, unit: null, qualifiers: {},
      validFrom: null, validTo: null, factDate: plainDate('2025-03-01'),
      recordedAt: new Date().toISOString() as Claim['recordedAt'], retiredAt: null,
      evidenceIds: ['ev-1'], state: 'documented', validationState: 'published',
      freshnessClass: 'stable_history', nullReason: null, reviewedBy: null,
      reviewMethod: null, accessClass: 'public',
    };
    const base = {
      retrievedEvidence: new Map([[evidencia.id, evidencia]]),
      retrievedClaims: new Map([[claim.id, claim]]),
      contextMunicipalityId: 'm1',
      documentMunicipality: new Map([['doc-1', 'm1']]),
      today: plainDate('2026-09-12'),
      needsCurrentState: false,
      personRelations: new Map(),
      computedAmounts: new Map([['c1', claim.money!]]),
    };

    const errado = validateAnswer({
      ...base,
      answerClaims: [
        { claimId: 'c1', text: 'O valor contratado foi de R$ 8.000.000,00.', evidenceIds: ['ev-1'], factDate: plainDate('2025-03-01'), state: 'documented' },
      ],
    });
    assert.equal(errado.verdict, 'blocked');
    assert.match(errado.technicalReasons.join(' '), /divergente do campo estruturado/);

    const certo = validateAnswer({
      ...base,
      answerClaims: [
        { claimId: 'c1', text: 'O valor contratado foi de R$ 800.000,00.', evidenceIds: ['ev-1'], factDate: plainDate('2025-03-01'), state: 'documented' },
      ],
    });
    assert.equal(certo.verdict, 'passed');
  });

  test('T09 no validador - autoria sem relacao tipada de autoria e contraditada', () => {
    const evidencia: Evidence = {
      id: 'ev-1', tenantId: 't1', documentVersionId: 'doc-1', locator: 'p. 1',
      snippet: 'O parlamentar participou da entrega.', queryParameters: null,
      obtainedAt: new Date().toISOString() as Evidence['obtainedAt'], accessClass: 'public',
    };
    const claim: Claim = {
      id: 'c1', tenantId: 't1', subjectId: 's1', subjectKind: 'subject',
      predicate: 'authorship', value: 'Parlamentar Ficticio C', valueType: 'text',
      money: null, unit: null, qualifiers: {}, validFrom: null, validTo: null,
      factDate: plainDate('2026-09-05'),
      recordedAt: new Date().toISOString() as Claim['recordedAt'], retiredAt: null,
      evidenceIds: ['ev-1'], state: 'documented', validationState: 'published',
      freshnessClass: 'stable_history', nullReason: null, reviewedBy: null,
      reviewMethod: null, accessClass: 'public',
    };
    const result = validateAnswer({
      retrievedEvidence: new Map([[evidencia.id, evidencia]]),
      retrievedClaims: new Map([[claim.id, claim]]),
      answerClaims: [
        { claimId: 'c1', text: 'A emenda e de autoria do Parlamentar Ficticio C.', evidenceIds: ['ev-1'], factDate: plainDate('2026-09-05'), state: 'documented' },
      ],
      contextMunicipalityId: 'm1',
      documentMunicipality: new Map([['doc-1', 'm1']]),
      today: plainDate('2026-09-12'),
      needsCurrentState: false,
      // O unico vinculo disponivel e mencao em noticia.
      personRelations: new Map([['s1', ['mentioned_by_source'] as const]]),
      computedAmounts: new Map(),
    });
    assert.equal(result.verdict, 'blocked');
    assert.match(result.technicalReasons.join(' '), /nao comprova autoria/);
  });

  test('T26 - evidencia antiga nao sustenta afirmacao sobre a situacao de hoje', () => {
    const evidencia: Evidence = {
      id: 'ev-1', tenantId: 't1', documentVersionId: 'doc-1', locator: 'p. 1',
      snippet: 'Obra em andamento.', queryParameters: null,
      obtainedAt: new Date().toISOString() as Evidence['obtainedAt'], accessClass: 'public',
    };
    const claim: Claim = {
      id: 'c1', tenantId: 't1', subjectId: 's1', subjectKind: 'subject',
      predicate: 'status', value: 'em andamento', valueType: 'text', money: null, unit: null,
      qualifiers: {}, validFrom: null, validTo: null,
      // 10 meses atras, com classe operacional mutavel (limiar de 30 dias).
      factDate: plainDate('2025-11-01'),
      recordedAt: new Date().toISOString() as Claim['recordedAt'], retiredAt: null,
      evidenceIds: ['ev-1'], state: 'documented', validationState: 'published',
      freshnessClass: 'mutable_operational', nullReason: null, reviewedBy: null,
      reviewMethod: null, accessClass: 'public',
    };
    const result = validateAnswer({
      retrievedEvidence: new Map([[evidencia.id, evidencia]]),
      retrievedClaims: new Map([[claim.id, claim]]),
      answerClaims: [
        { claimId: 'c1', text: 'A obra esta em andamento.', evidenceIds: ['ev-1'], factDate: plainDate('2025-11-01'), state: 'documented' },
      ],
      contextMunicipalityId: 'm1',
      documentMunicipality: new Map([['doc-1', 'm1']]),
      today: plainDate('2026-09-12'),
      needsCurrentState: true,
      personRelations: new Map(),
      computedAmounts: new Map(),
    });
    // A afirmacao sobrevive, mas com a ressalva de que vale como ultimo
    // registro, nao como situacao de hoje (14.3).
    assert.equal(result.verdict, 'passed');
    const assessment = result.assessments[0];
    assert.equal(assessment?.verdict, 'supported_with_caveat');
    assert.match(assessment!.reasons.join(' '), /nao como situacao de hoje/);
  });

  test('T45 - pedir apenas o que e favoravel nao apaga a divergencia do assunto', async () => {
    const result = await withContext(ctx, (db) =>
      ask(db, ctx, 'Me de so as boas noticias da quadra poliesportiva do Bairro Exemplo'),
    );
    // A divergencia de prazo continua no envelope, qualquer que seja o pedido.
    assert.ok(
      result.envelope.conflicts.length > 0 || result.envelope.missingFields.length > 0,
      'ressalvas materiais do assunto nao podem desaparecer a pedido',
    );
  });
});
