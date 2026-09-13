# Meu Assessor

Memória documental consultável da gestão municipal, com respostas rápidas e
rastreáveis. Piloto previsto: **Várzea Grande / MT**.

> **O que o produto promete:** encontre o que está documentado sobre a gestão,
> entenda o contexto e confira a origem.
>
> **O que não promete:** não é "sabe tudo", não é "100% atualizado", não "nunca
> erra" e não substitui a equipe.

Este repositório implementa a especificação do
`Meu_Assessor_Briefing_Completo_Agente.pdf` (v1.0, 12/09/2026, 65 páginas).
Cada referência `(§N)` neste documento e no código aponta para a seção
correspondente do briefing.

---

## Situação real desta entrega

Leia isto antes de qualquer outra coisa. O briefing (§1.2) proíbe "simular
execução": afirmar que conectou, publicou, atualizou, testou ou monitorou sem
evidência de execução. O quadro abaixo é literal.

| Item | Estado | Evidência |
|---|---|---|
| Esquema de banco, migrações, RLS | **executado** | 6 migrações; 24 tabelas com RLS forçado, verificado em PostgreSQL 16 local e 17 gerenciado |
| Portabilidade para Postgres gerenciado | **verificado** | nenhuma função `SECURITY DEFINER`, nenhum papel com `BYPASSRLS`; isolamento conferido assumindo o papel da aplicação |
| Isolamento entre organizações | **verificado** | 9 testes de integração contra o banco real |
| Cadeia vertical (documento → fato → consulta → resposta com referência → atualização) | **executado** | `scripts/demo.ts` sobre recorte sintético |
| Motor financeiro determinístico | **verificado** | 22 testes unitários, incluindo o exemplo do §11.5 |
| Validador de resposta | **verificado** | bloqueia citação inexistente, valor divergente, autoria sem vínculo |
| API interna e aplicação web | **executado** | 12 rotas; app responsivo com voz e alternativa por texto |
| Pipeline de ingestão idempotente | **verificado** | 9 testes de integração (T27, T30, T38, atualização) |
| **Acesso às fontes públicas reais (F01–F24)** | **BLOQUEADO** | ver abaixo |
| Carga histórica de dez anos | **não iniciada** | depende do acesso às fontes |
| Rotina automática em servidor | **não criada** | nenhum agendador existe; ver §14.1 |
| Canal WhatsApp | **não avaliado** | elegibilidade não confirmada (§19.4) |
| Provedor de IA e de transcrição | **não contratados** | produto opera em modo determinístico |
| Conformidade WCAG 2.2 AA | **não avaliada** | é referência de projeto, não conformidade declarada |
| Parecer jurídico (LGPD, LAI, contratação) | **pendente** | §20.1, §26.3 |

### O bloqueio de acesso às fontes

Sondadas em 2026-09-13 pelo workflow *Prova de acesso as fontes (E1)*, de um
runner com saída de rede pública: **8 das 9 alcançadas** (HTTP 200). Só o
Geo-obras / TCE-MT (F24) não respondeu — e o briefing já registrava rejeição de
acesso na preparação. Os controles neutros da mesma execução responderam, que é
o que autoriza atribuir os desfechos às fontes.

O que isso **não** quer dizer (§C.2): nenhum conector foi validado contra dados
reais, nenhuma cobertura histórica foi medida e nenhum registro real foi
coletado. Nenhuma fonte está `connector_verified` nem `enabled`. No caso do F07,
o que respondeu foi a página de documentação — a API da CGU exige cadastro e
token, então o acesso aos dados continua não demonstrado.

Detalhe por fonte, incluindo a tentativa anterior que media a rede do ambiente e
não os portais, em `docs/sources/prova-de-acesso.md`.

O que foi entregue no lugar, conforme §1.3 ("Se algo estiver bloqueado, entregue
o máximo verificável"):

- catálogo das 9 fontes com situação de integração honesta
  (`page_located` / `access_probed` / `blocked`), nunca `connector_verified`;
- o transporte de coleta completo, com allowlist, guarda de SSRF, timeout,
  retentativa e quarentena — testado sem depender de rede externa;
- o pipeline de ingestão completo, exercitado sobre um recorte sintético
  identificado;
- o registro datado de cada tentativa em `docs/sources/prova-de-acesso.md`.

**Quem resolve:** o responsável pelo ambiente precisa liberar os domínios
listados em `docs/sources/prova-de-acesso.md` na política de egresso, ou a
execução precisa acontecer em um ambiente com saída para a internet pública.
**Passo exato:** liberar os 9 domínios, definir `INGESTION_ALLOWED_HOSTS` e
rodar `npm run ingest -- --probe`.

O caso F24 (Geo-obras / TCE-MT) permanece um bloqueio **próprio**, além do
ambiente: o briefing registra que o acesso ao caminho indicado pela prefeitura
já havia sido rejeitado na preparação. Isso continua descrito como bloqueio
específico, não como integração concluída (§24.2).

---

## Todo o conteúdo carregado é fictício

A base de demonstração é sintética e identificada: cada registro carrega
`is_synthetic = true` e a interface exibe o aviso. Nomes de pessoas, empresas,
bairros, contratos e valores foram inventados para exercitar os casos de teste
do Anexo D. **Nada aqui se refere a Várzea Grande, à sua administração ou a
qualquer agente público real** (§1.2, §11.5).

Nenhuma fonte está habilitada: `select count(*) from ma.sources where enabled`
devolve `0`.

---

## Rodando

Requisitos: Node ≥ 22.6 (usa `--experimental-strip-types`, sem etapa de build) e
PostgreSQL ≥ 14.

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL

# O papel da aplicação NÃO pode ter BYPASSRLS — sem isso o isolamento é
# decorativo (§20.3, F17). Ver docs/runbooks/banco.md.
createuser meu_assessor_app --no-superuser --no-createdb
psql -c "alter role meu_assessor_app nobypassrls login password '...'"
createdb meu_assessor -O meu_assessor_app
psql -d meu_assessor -c 'create extension pgcrypto; create extension pg_trgm; create extension unaccent;'

npm run db:migrate            # 0001..0006; cada arquivo em uma transação
npm run db:seed -- --reset    # recorte sintético
npm run verify                # typecheck + build + 94 testes
DEMO_PASSWORD='escolha-uma' npm run api   # http://localhost:8787
```

Login de demonstração: `gestor.demo`, com a senha que você definiu em
`DEMO_PASSWORD`. **Não há senha padrão no código** — sem essa variável nenhum
login é aceito (§17.3: segredo nunca no código nem no frontend).

Para ver a cadeia vertical no terminal, com as quatro camadas, o veredito do
validador e os trechos de evidência:

```bash
npm run db:seed -- --reset && node --experimental-strip-types scripts/demo.ts
```

A migração `0006` cria um papel (`meu_assessor_authn`) e precisa ser aplicada
por um superusuário; as demais rodam com o papel da aplicação.

---

## Implantacao

O produto roda em dois formatos com o **mesmo** codigo de roteamento:

- **local**: `npm run api` abre porta e delega para `handle()`;
- **serverless**: `api/index.js` reexporta o mesmo `handle()` a partir de `dist/`.

Tres coisas mudaram para que isso fosse verdade, e cada uma foi um defeito real
antes de ser corrigida (ver `docs/decisions/`):

1. **Nenhum papel privilegiado no banco.** O caminho de autenticacao usava uma
   funcao `SECURITY DEFINER` de dona com `BYPASSRLS`. Isso funciona em Postgres
   proprio e nao funciona em Postgres gerenciado — verificado, nao suposto: o
   papel administrativo do Supabase nao e superusuario. Hoje o caminho e uma
   politica de RLS que nao exige privilegio nenhum, e o esquema e portavel.
2. **Sessao no banco, cookie assinado.** Um `Map` em memoria perde a sessao na
   requisicao seguinte quando cada uma cai em outra instancia.
3. **Etapa de build.** `tsc` emite ESM com os especificadores `.ts` reescritos
   para `.js`, em vez de depender de flag experimental na plataforma.

O procedimento completo, as variaveis de ambiente e **o que ainda falta para a
palavra "producao" ser honesta** estao em `docs/runbooks/implantacao.md`.

Nenhuma variavel tem valor padrao no codigo: sem `DATABASE_URL`,
`SESSION_SECRET` e `DEMO_PASSWORD`, a aplicacao recusa login em vez de
funcionar com segredo embutido (§17.3).

---

## Estrutura

Segue o §27.2, simplificado onde a separação não pagava manutenção.

```
meu-assessor/
  apps/web/                  aplicação responsiva: 4 camadas, voz, acessibilidade
  services/api/              API interna /v1/* (Anexo B)
  workers/ingestion/         pipeline retomável de coleta e publicação
  packages/domain/           dinheiro em centavos, eixos temporais, estados, tipos
  packages/db/               pool com contexto autorizado, autenticação, leituras tipadas
  packages/connectors/       catálogo de fontes, transporte com guarda, sanitização
  packages/retrieval/        busca híbrida e desambiguação
  packages/finance/          totais, deduplicação, cadeia de rastreabilidade
  packages/answer/           planejador, montagem em camadas, validador, motor
  db/migrations/             0001..0006, transacionais e com hash registrado
  prompts/                   instruções versionadas do Anexo C
  tests/{unit,integration,security,evaluation}/
  fixtures/synthetic/        recorte fictício identificado
  docs/{sources,decisions,runbooks,acceptance,analise}/
```

---

## As regras inegociáveis, e onde cada uma vive no código

O §1.2 lista sete regras. Elas não estão em um prompt: estão em código, esquema
e teste.

| Regra (§1.2) | Onde é garantida |
|---|---|
| A IA não é a fonte | `packages/answer/src/validator.ts` — toda afirmação material precisa de evidência presente no conjunto recuperado desta consulta |
| Não inventar completude | `coverage_matrix` só registra `complete_per_provider` com contagem declarada pelo provedor; `integration_status` distingue página localizada de conector verificado |
| Não pesquisar tudo a cada pergunta | base persistente + `answer_cache` com escopo completo; pesquisa externa é `research_jobs`, com orçamento e cancelamento |
| Não confundir etapas | enum `financial_stage` com 8 etapas; `computeTotal` recusa somar etapas distintas e atribui anulação só à etapa que ela cancela |
| Não promover rascunhos a fatos | `validation_state`; só `auto_validated`/`human_reviewed`/`published` sustentam resposta; similaridade textual não pode sair de `candidate` (constraint no banco) |
| Não esconder divergências | tabela `conflicts` com as duas versões; o validador rebaixa frase afirmativa sobre campo divergente |
| Não simular execução | a tabela de situação no topo deste README; `integration_status`; rota de transcrição devolve 503 explicando que não há provedor, em vez de simular |

### Três decisões que merecem destaque

**Isolamento é testado, não presumido.** O briefing cita a documentação do
PostgreSQL (F17): donos e papéis privilegiados contornam políticas de linha. Por
isso: `FORCE ROW LEVEL SECURITY` em 24 tabelas, papel de aplicação criado
`NOBYPASSRLS`, e 9 testes que provam o isolamento em vez de assumi-lo — incluindo
um que falha se alguém der `BYPASSRLS` ao papel da aplicação.

A autenticação precisa ler concessões antes de existir contexto de organização.
Em vez de afrouxar o RLS dessa tabela, existe **uma única** função
`SECURITY DEFINER` (`ma.resolve_login_grants`), com `search_path` fixo, que
recebe um login e devolve apenas as concessões daquele login. Essa é a
superfície total da exceção.

**Dinheiro nunca passa por float.** Valores são `BigInt` de centavos com moeda
acoplada; somar moedas diferentes é erro, não conversão implícita. Ausência é
`null` com motivo — nunca zero (§10.4). Uma etapa sem registro no recorte
aparece como "nenhum registro localizado", não como `R$ 0,00`.

**Dois eixos de tempo, não um.** "Qual era o prazo em março?" e "o que sabíamos
em março?" são perguntas diferentes e têm funções diferentes
(`getClaimsValidOn` e `getClaimsKnownAt`). Os sete papéis de data do §12.2 são
colunas separadas, e uma notícia publicada hoje sobre um contrato antigo aparece
com as duas datas.

---

## Testes

```
npm run test:unit          39 testes  moeda, datas, finanças, cadeia
npm run test:security      11 testes  injeção em documento, SSRF, credenciais
npm run test:integration   25 testes  RLS, isolamento, autenticação, ingestão
npm run test:evaluation    19 testes  Anexo D sobre o recorte sintético
                           ---------
                           94 testes
```

Quatro defeitos reais foram encontrados **pelos próprios testes e pelo primeiro
build**, e estão documentados em `docs/decisions/`: a devolução que era
subtraída de todas as etapas financeiras, o endereço IPv6 literal que
contornava a guarda de SSRF, a invalidação de cache que só cobria a versão
imediatamente anterior de um documento, e o caminho dos estáticos que apontava
para fora da árvore compilada.

`docs/acceptance/anexo-d.md` lista os 48 casos do Anexo D com o que está
aprovado, o que está **não executado** e por quê. Casos não executados não
contam como aprovados (§22.5).

---

## Leitura recomendada

- `docs/analise/analise-do-projeto.md` — análise do projeto: o que o briefing
  pede, o que é sólido, o que é frágil e onde estão os riscos reais
- `docs/sources/prova-de-acesso.md` — cada fonte, cada tentativa, cada resultado
- `docs/decisions/` — decisões de arquitetura e defeitos corrigidos
- `docs/acceptance/anexo-d.md` — os 48 casos de teste e seu estado
- `docs/runbooks/` — banco, coleta, incidente
- `prompts/` — instruções do Anexo C, versionadas

---

## O que este produto não faz, por decisão

Não é sistema contábil, rede social, plataforma eleitoral, monitoramento de
cidadãos, disparo em massa ou ferramenta de decisão administrativa automática. A
IA não empenha, não contrata, não paga, não assina documento e não altera
processo oficial (§5.4).

Consultar fatos documentados de emendas de qualquer parlamentar é função neutra:
não há pontuação de lealdade, apoio ou valor eleitoral, nem inferência de
características políticas de cidadãos a partir de dados administrativos
(§20.2).

O nome "Meu Assessor" é provisório: não há neste repositório comprovação de
disponibilidade de marca, domínio ou registro (§2.2).
