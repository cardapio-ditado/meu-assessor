# Dicionario de dados

Anexo A do briefing, traduzido para o esquema `ma`. As denominacoes tecnicas sao
propostas e podem ser ajustadas sem perder significado (A.1).

## Campos transversais (A.1)

Presentes na maioria das tabelas de negocio:

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` | gerado pelo sistema; nome nunca e chave |
| `tenant_id` | `uuid` | contexto derivado da sessao; **nunca** aceito do navegador |
| `municipality_id` | `uuid` | separado da organizacao; um tenant pode ter mais de um municipio |
| `source_id` | `uuid` | obrigatorio quando o registro foi importado |
| `external_id` | `text` | identificador original, preservado sem perda de zeros |
| `record_version` | `integer` | imutavel em versoes ja usadas em respostas |
| `created_at` / `recorded_at` | `timestamptz` | momento tecnico; **nao** substitui a data do fato |
| `access_class` | enum | `public`, `internal_authorized`, `restricted`, `blocked` |
| `validation_state` | enum | 10 estados (A.1 e 12.4) |
| `supersedes_id` | `uuid` | liga a versao nova a anterior sem apagar a historia |
| `is_synthetic` | `boolean` | dado ficticio sempre identificado (1.2) |

## Convencoes de tipo (10.4)

- **Dinheiro**: `numeric(18,2)` no banco, `BigInt` de centavos na aplicacao,
  com a moeda em coluna propria. Nunca `float`/`double`.
- **Datas sem horario**: `date`. Nao se inventa meia-noite como momento do fato.
- **Timestamps tecnicos**: `timestamptz` em UTC, exibidos no fuso do municipio.
- **Desconhecido**: `null` com motivo em `null_reason`. Zero e um valor
  conhecido e nao substitui ausencia.
- **Texto**: grafia original em `*_original`, forma comparavel em
  `*_normalized`. Aliases sao curados, sem modificar o original.

## Tabelas

### Organizacao e acesso
| Tabela | Papel | RLS |
|---|---|---|
| `tenants` | organizacao cliente | nao (lida antes de existir contexto) |
| `municipalities` | municipio, UF, fuso, CNPJ do ente principal | nao |
| `tenant_municipalities` | quais municipios cada organizacao cobre | sim |
| `users` | identidade do cadastro validado | nao |
| `user_grants` | papel + classes de acesso por organizacao | sim (leitura de login via `ma.resolve_login_grants`) |
| `organs` | orgao ou unidade, com **vigencia** | sim |
| `localities` | bairro, distrito, com aliases | sim |

### Fontes e documentos
| Tabela | Papel |
|---|---|
| `sources` | ficha obrigatoria do 8.4, incluindo `integration_status` e `enabled` |
| `source_datasets` | conjuntos de uma mesma fonte, com cadencias diferentes |
| `source_runs` | execucoes de coleta: intervalo pedido, encontrado, contagens, checkpoint |
| `document_versions` | documento **e versao**; `search_vector` gerado em portugues |
| `evidence` | trecho ancorado, com `query_parameters` sem credenciais |
| `coverage_matrix` | matriz do 9.3: pedido x encontrado, cobertura de campos, limitacao |

### Entidades e fatos
| Tabela | Papel |
|---|---|
| `entities` | orgao, pessoa, localidade, assunto, licitacao, contrato, emenda, instrumento, noticia |
| `entity_matches` | correspondencia entre identificadores de fontes; similaridade textual **nao pode sair de candidato** (constraint) |
| `claims` | afirmacao com sujeito, predicado, valor, qualificadores, dois intervalos temporais e estado |
| `claim_evidence` | ligacao afirmacao-evidencia, com o que a evidencia sustenta |
| `person_relations` | 13 tipos de vinculo; "mencionado em noticia" nunca vira autoria |
| `financial_events` | etapa, medida (fluxo ou posicao acumulada), documento financeiro, evento cancelado |
| `chain_links` | elos da cadeia 11.3; exige identificador compartilhado ou evidencia |

### Consulta e operacao
| Tabela | Papel |
|---|---|
| `answers` | trilha completa: pergunta, plano, envelope, versoes, veredito do validador |
| `answer_cache` | chave com organizacao, acesso, consulta, periodo e versoes (16.3) |
| `review_queue` | fila priorizada com extracao original e proposta (21.2) |
| `conflicts` | as duas versoes preservadas, com criterio de prevalencia (12.3) |
| `gaps` | lacuna com pergunta concreta e unidade competente (9.4) |
| `research_jobs` | pesquisa complementar com orcamento e idempotencia (15.4) |
| `audit_log` | acesso e alteracao |

## Restricoes que carregam regra de negocio

| Constraint | Regra do briefing |
|---|---|
| `null_needs_reason` | valor nulo exige motivo (10.4) |
| `money_needs_currency` | valor monetario sem moeda nao existe (10.4) |
| `similarity_stays_candidate` | associacao por similaridade permanece candidata (10.3) |
| `link_needs_support` | elo publicado exige identificador ou evidencia (11.3) |
| `duplicate_needs_target` | duplicata conciliada aponta o original (A.4) |
| `decision_needs_justification` | decisao de revisao exige justificativa (21.2) |
| `evidence_snippet_not_empty` | evidencia sem trecho nao e evidencia (12.1) |
| `distinct_claims` | um conflito e entre duas afirmacoes diferentes |
| `claim_evidence` FK `on delete restrict` | evidencia nao desaparece debaixo de uma afirmacao que a cita |
