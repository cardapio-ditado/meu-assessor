# Runbook — coleta de fontes

## Antes de ativar uma fonte (checklist F.1)

Nenhuma fonte nasce `enabled`. Antes de mudar isso:

1. confirmar dominio e orgao responsavel;
2. testar o acesso permitido e registrar o resultado, com data;
3. verificar autenticacao e, se houver, de quem e a credencial;
4. documentar o esquema devolvido;
5. validar identificadores (numero de contrato sem orgao e exercicio nao e chave, §10.3);
6. medir paginacao e confirmar o comportamento no fim da lista;
7. confirmar quais campos de data a fonte fornece, e a qual dos sete papeis do §12.2 cada um corresponde;
8. registrar cadencia declarada pelo provedor;
9. examinar termos de uso e regras de reutilizacao;
10. classificar o acesso dos dados;
11. criar teste de contrato com amostra preservada;
12. definir limites de paginas, registros e tempo;
13. cadastrar o responsavel operacional;
14. registrar cobertura e falhas conhecidas na ficha do §8.4.

**Criterio de conclusao:** outra pessoa consegue executar o conector e
reproduzir uma amostra com os mesmos filtros.

Somente apos isso: `integration_status = 'connector_verified'` e `enabled = true`.

## Executar uma coleta

```bash
export INGESTION_ALLOWED_HOSTS='www.varzeagrande.mt.gov.br,diariooficial.varzeagrande.mt.gov.br'
DATABASE_URL=... npm run ingest
```

Com `INGESTION_ALLOWED_HOSTS` vazio **nao ha coleta externa**. Isso e
deliberado: evita coleta acidental em desenvolvimento e torna explicito o
conjunto de destinos autorizados.

## Retomar um lote

Cada `source_runs` guarda `checkpoint`, intervalo pedido e intervalo encontrado.
Um erro de extracao nao obriga a repetir downloads concluidos (§13.1). A
repeticao do mesmo lote nao cria documento novo: o upsert compara o hash do
conteudo e so cria nova `record_version` quando ele muda (§13.3, T38).

## Quarentena

Conteudo com instrucao embutida (§20.4, T30) nunca e extraido: vai para
`audit_log` com `action = 'injection_detected'` e abre item em `review_queue`
com prioridade 90. O documento **nao** e publicado.

Mudanca de esquema da fonte tambem coloca o lote em quarentena, ate validacao
(§13.4). Falha de autenticacao **nao** gera retentativa infinita.

## "Sem novidades" exige coleta bem-sucedida

`last_success_at` so avanca quando a execucao nao foi um fracasso. Quando a
coleta falhou, a frase correta e "nao foi possivel verificar novidades nesta
fonte" — nunca "sem novidades" (§14.4).

Uma resposta HTTP 200 com tabela vazia pode ser filtro quebrado:
`assessEmptyBatch` compara com a contagem declarada pelo provedor e com o
historico do conjunto antes de aceitar o vazio (§13.4, T27).
