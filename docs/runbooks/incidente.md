# Runbook — incidente

§20.6. O agente ou operador **nao** esconde falha para manter aparencia de
estabilidade.

## Conter

1. suspender acessos afetados (`ma.user_grants.revoked_at`);
2. revogar chaves e credenciais dos conectores envolvidos;
3. desabilitar as fontes afetadas (`ma.sources.enabled = false`);
4. invalidar cache dependente: `delete from ma.answer_cache where ...`;
5. preservar evidencias tecnicas antes de qualquer limpeza.

## Avaliar

- `ma.audit_log` — quem acessou o que, e quando;
- `ma.answers` — quais respostas foram emitidas com quais fontes e versoes;
- `ma.source_runs` — quais coletas rodaram no periodo.

Se dados de uma organizacao podem ter aparecido para outra, isso e vazamento e
**bloqueia a versao** (§22.5). Corrigir a causa, ampliar o caso de regressao em
`tests/integration/isolation.test.ts` e repetir a suite relevante.

## Corrigir informacao ja emitida

Uma correcao material (§12.5):

1. gera **nova versao**, sem sobrescrever a anterior;
2. registra motivo e autor;
3. invalida indices, cache e resumos dependentes;
4. marca as respostas afetadas em `ma.answers.affected_by_correction_at`;
5. na proxima abertura, avisa que a informacao mudou.

O historico da consulta **nao** e reescrito para fazer parecer que a resposta
antiga ja estava correta.

## Comunicar

Prazos e destinatarios seguem a politica aprovada e a legislacao vigente. Este
runbook nao define prazo legal: isso depende do parecer juridico pendente
(§20.1).

## Revogacao de acesso

Cache com documento restrito **nao** pode sobreviver a retirada da permissao
(§16.3, T34). Ao revogar um grant, invalidar todo cache cuja
`access_signature` corresponda ao usuario afetado.
