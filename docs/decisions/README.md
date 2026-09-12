# Registro de decisoes

O briefing §1.3 exige registrar decisoes tecnicas reversiveis em um documento de
decisoes, e §1.4 exige estados objetivos: planejado, implementado, executado,
verificado, bloqueado.

| # | Decisao | Estado | Motivo |
|---|---|---|---|
| D01 | Node 22 + TypeScript com `--experimental-strip-types`, sem etapa de build | verificado | tipos reais com duas dependencias apenas (`pg`, `typescript`); §17.3 pede migracoes e deploy reproduzivel, nao um bundler |
| D02 | PostgreSQL com busca textual em portugues e `pg_trgm` | verificado | §15.1 e F22; a combinacao encontra numero exato, nome oficial, apelido curado e grafia aproximada |
| D03 | pgvector **nao** utilizado | bloqueado | extensao indisponivel no ambiente; §15.1 a trata como opcao, nao obrigacao. Reavaliar quando houver volume que justifique |
| D04 | Monolito modular com pacotes por dominio | implementado | §17.1 recomenda explicitamente evitar microservicos antes da necessidade |
| D05 | `FORCE ROW LEVEL SECURITY` + papel `NOBYPASSRLS` + testes de isolamento | verificado | F17 e §20.3: ativar RLS nao basta, e o dono da tabela contorna politica sem FORCE |
| D06 | Uma unica funcao `SECURITY DEFINER` para o caminho de autenticacao | verificado | a autenticacao precisa ler concessoes antes de existir contexto; a alternativa (tirar RLS da tabela de grants) exporia acessos entre organizacoes |
| D07 | Dinheiro como `BigInt` de centavos com moeda acoplada | verificado | §10.4 proibe ponto flutuante binario em calculo financeiro |
| D08 | Modo deterministico sem provedor de IA | executado | §17.4 separa fornecedor de IA da logica de negocio; o produto responde, cita e recusa sem modelo. Adicionar modelo e melhoria, nao fundacao |
| D09 | Nenhuma fonte nasce `enabled` | executado | §8.1 e C.2: ativar conector e decisao de operacao autorizada |
| D10 | Coleta externa exige `INGESTION_ALLOWED_HOSTS` explicito | verificado | lista vazia significa nenhuma coleta; evita coleta acidental em desenvolvimento |
| D11 | Recorte de demonstracao sintetico, com `is_synthetic` em cada registro | executado | §1.2: dados ficticios identificados e separados dos reais |
| D12 | Extracao de PDF nao implementada | planejado | depende de amostra real do diario oficial para escolher entre texto nativo e OCR (§13.2). Ver analise, secao 6 |

## Defeitos encontrados pelos testes e corrigidos

Registrados porque mostram o tipo de erro que este dominio produz: todos os tres
geram saida plausivel e nenhum seria pego por inspecao visual.

### DF01 — anulacao subtraida de todas as etapas financeiras

Uma devolucao de R$ 50.000,00 vinculada a um repasse aparecia como
`Empenhado: -R$ 50.000,00` e `Pago ao fornecedor: -R$ 50.000,00`, porque
`computeTotal` aceitava qualquer evento de etapa `cancelled` independentemente da
etapa consultada.

Correcao: uma anulacao pertence a etapa do evento que ela cancela
(`cancels_event_id`). Sem esse vinculo ela nao entra em total nenhum e gera
ressalva, permanecendo visivel no historico. §11.4 e T14.
Teste: `tests/unit/finance.test.ts`, "T14 - a devolucao reduz apenas a etapa do
evento que ela cancela".

### DF02 — IPv6 literal contornava a guarda de SSRF

`URL.hostname` devolve enderecos IPv6 entre colchetes (`[::1]`). Com os
colchetes, `isIP()` devolvia 0 e a verificacao de faixa bloqueada nao rodava.
Correcao: remover colchetes antes da checagem. §20.4 e T31.
Teste: `tests/security/sanitize.test.ts`.

### DF03 — invalidacao de cache cobria apenas a versao anterior

A chegada da versao 3 de um documento invalidava somente o cache que dependia da
versao 2. Uma resposta em cache montada sobre a versao 1 sobrevivia.
Correcao: invalidar o cache que depende de qualquer versao da linhagem do
documento. §12.5.
Teste: `tests/integration/ingestion.test.ts`.

### DF04 — falso positivo no detector de instrucao embutida

O padrao de "autorizacao falsa" casava com a palavra "autorizado", que e
vocabulario financeiro normal — "valor autorizado" e uma etapa do §11.1. O
registro da emenda do recorte sintetico ia para quarentena indevidamente.
Correcao: o sinal passou a exigir concessao de permissao dirigida ao sistema.
Teste: `tests/security/sanitize.test.ts`, "documento administrativo comum nao
dispara alarme".

### DF05 — desambiguacao disparando em excesso

Um nome oficial completo digitado pelo usuario caia em pergunta de
desambiguacao, contra o §15.2 ("nao fazer cinco perguntas tecnicas para
responder algo que os identificadores ja resolvem"). Duas causas: faltava o
caminho de "nome contido na pergunta", e o teto de pontuacao da busca textual
(0.85) deixava um nome exato a apenas 0.10 de distancia, abaixo da margem de
0.15. Correcao: caminho `name_contained` e teto textual reduzido para 0.75.
Teste: `tests/evaluation/anexo-d.test.ts`, T02 e T08.
