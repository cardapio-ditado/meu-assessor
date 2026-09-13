/**
 * Demonstracao local do caminho de consulta (E2). Executa as perguntas das
 * jornadas do briefing sobre o recorte sintetico e imprime as quatro camadas,
 * o veredito do validador e as evidencias.
 *
 * Uso: DATABASE_URL=... node --experimental-strip-types scripts/demo.ts
 */
import { closePool, withContext } from '../packages/db/src/pool.ts';
import { contextFor } from '../packages/db/src/auth.ts';
import { ask, recordAnswer } from '../packages/answer/src/engine.ts';
import { getEvidence, getRecentCards, getCoverage } from '../packages/db/src/repository.ts';
import { dateRange, plainDate } from '../packages/domain/src/temporal.ts';
import { ENTITY_KIND_LABEL } from '../packages/domain/src/states.ts';

const context = await contextFor('gestor.demo', 'demonstracao');

const questions = [
  'Como esta a quadra poliesportiva municipal?',
  'Como esta a quadra do bairro Exemplo?',
  'Como esta a quadra poliesportiva do Bairro Exemplo?',
  'A reforma da UBS do Bairro Modelo terminou?',
  'Quanto foi transferido pela Emenda Ficticia Coletiva 2026/EX-0001?',
  'Como esta o poco artesiano do Distrito Amostra?',
  'O que mudou nos ultimos dez dias?',
];

await withContext(context, async (db) => {
  console.log(`\nOrganizacao: ${context.tenantSlug}   Municipio: ${context.municipalityName}`);
  console.log(`Classes de acesso da sessao: ${context.accessClasses.join(', ')}\n`);

  console.log('='.repeat(78));
  console.log('T02 / FEED: cartoes recentes, com data do evento separada da publicacao');
  console.log('='.repeat(78));
  const cards = await getRecentCards(db, dateRange(plainDate('2026-09-01'), plainDate('2026-09-12')), 5);
  if (cards.length === 0) console.log('  (nenhum cartao na janela)');
  for (const card of cards) {
    console.log(`  - ${card.subjectName} [${card.area ?? 'sem area'}] ${card.isSynthetic ? '(sintetico)' : ''}`);
    console.log(`      data do evento: ${card.factDate ?? 'nao informada'} | publicacao: ${card.publicationDate ?? 'nao informada'} | estado: ${card.state}`);
  }

  for (const question of questions) {
    console.log(`\n${'='.repeat(78)}`);
    console.log(`PERGUNTA: ${question}`);
    console.log('='.repeat(78));
    const result = await ask(db, context, question);
    const { envelope, plan, validation } = result;

    console.log(`intencao=${plan.intent}  risco=${plan.riskClass}  status=${envelope.status}  validador=${validation.verdict}  ${result.latencyMs}ms`);
    console.log(`periodo aplicado: ${envelope.context.period}${plan.periodIsDefault ? ' (padrao, alteravel)' : ''}`);

    console.log('\n[1] EM POUCOS SEGUNDOS');
    console.log(`  ${envelope.layers.brief}`);

    if (envelope.status === 'clarification_needed' && result.candidates.length > 1) {
      console.log('\nESCOLHAS (nenhuma afirmacao sai antes da escolha)');
      for (const c of result.candidates.slice(0, 5)) {
        const detalhe = [c.localityName, ENTITY_KIND_LABEL[c.kind] ?? c.kind].filter(Boolean).join(' - ');
        console.log(`  - ${c.officialName}${detalhe === '' ? '' : ` (${detalhe})`}  [${c.matchKind}]`);
      }
    }

    if (envelope.layers.understand.length > 0) {
      console.log('\n[2] ENTENDA');
      for (const fact of envelope.layers.understand) {
        console.log(`  ${fact.label}: ${fact.value}`);
        console.log(`      estado=${fact.state}  data do fato=${fact.factDate ?? 'nao informada'}  evidencias=${fact.evidenceIds.length}`);
      }
    }

    if (envelope.layers.history.length > 0) {
      console.log('\n[3] HISTORICO E RELACOES');
      for (const item of envelope.layers.history.slice(0, 6)) {
        console.log(`  ${item.factDate ?? '????-??-??'} (publicado ${item.publicationDate ?? 'n/d'}) ${item.relationNature}: ${item.title.slice(0, 64)}`);
      }
    }

    if (envelope.layers.prove.length > 0) {
      console.log('\n[4] COMPROVE');
      const evidence = await getEvidence(db, envelope.layers.prove);
      for (const id of envelope.layers.prove.slice(0, 4)) {
        const e = evidence.get(id);
        if (e === undefined) {
          console.log(`  ${id}: NAO RECUPERAVEL (o validador deveria ter bloqueado a afirmacao)`);
          continue;
        }
        console.log(`  ${e.locator}: "${e.snippet.slice(0, 140).replace(/\s+/g, ' ')}..."`);
      }
    }

    if (envelope.conflicts.length > 0) {
      console.log('\nDIVERGENCIAS');
      for (const c of envelope.conflicts) console.log(`  - ${c}`);
    }
    if (envelope.missingFields.length > 0) {
      console.log('\nO QUE AINDA NAO FOI CONFIRMADO');
      for (const g of envelope.missingFields) console.log(`  - ${g}`);
    }
    if (envelope.warnings.length > 0) {
      console.log('\nRESSALVAS');
      for (const w of envelope.warnings) console.log(`  - ${w}`);
    }
    if (validation.removedClaims.length > 0) {
      console.log('\nBLOQUEADO PELO VALIDADOR');
      for (const reason of validation.technicalReasons) console.log(`  - ${reason}`);
    }

    await recordAnswer(db, context, result);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('COBERTURA DAS FONTES (7.9 / 12)');
  console.log('='.repeat(78));
  for (const row of await getCoverage(db)) {
    console.log(
      `  ${row.sourceCode}/${row.datasetName.padEnd(14)} integracao=${row.integrationStatus.padEnd(14)} ` +
        `ultima coleta ok=${row.lastSuccessAt?.slice(0, 19) ?? 'nunca'} ${row.stale ? '[DEFASADO]' : ''}`,
    );
  }
});

await closePool();
