# Prova de acesso às fontes — E1 (§24.2)

Data da execução: **2026-09-12**
Ambiente: contêiner de execução remota deste repositório
Ferramenta: `curl 8.5.0`, seguindo redirecionamentos, timeout de 25 s,
`User-Agent: MeuAssessor-AccessProbe/0.1`

## Resultado: E1 NÃO cumprida

Nenhuma das 9 fontes do catálogo foi alcançada. Todas falharam no
estabelecimento do túnel HTTPS, com **403 no CONNECT do proxy de egresso**.

```
F01 Prefeitura VG            curl: (56) CONNECT tunnel failed, response 403
F02 Transparencia VG         curl: (56) CONNECT tunnel failed, response 403
F03 Emendas VG               curl: (56) CONNECT tunnel failed, response 403
F04 Diario Oficial VG        curl: (56) CONNECT tunnel failed, response 403
F05 AMM-MT                   curl: (56) CONNECT tunnel failed, response 403
F06 PNCP                     curl: (56) CONNECT tunnel failed, response 403
F07 CGU API                  curl: (56) CONNECT tunnel failed, response 403
F10 Transferegov             curl: (56) CONNECT tunnel failed, response 403
F24 Geo-obras TCE-MT         curl: (56) CONNECT tunnel failed, response 403
```

## O bloqueio é do ambiente, não dos portais

Isso foi verificado, não suposto. No mesmo ambiente, no mesmo instante:

```
https://registry.npmjs.org/         200
https://pypi.org/simple/            200
https://api.github.com/rate_limit   200
https://example.com/                falha (403 no CONNECT)
https://www.planalto.gov.br/        falha (403 no CONNECT)
```

Um host neutro (`example.com`) e um host de legislação
(`planalto.gov.br`) falham do mesmo modo que os portais municipais, enquanto
registros de pacotes e a API do GitHub respondem. A política de egresso do
ambiente permite uma allowlist estreita e recusa todo o resto.

A documentação do próprio proxy instrui: *"The destination host is not allowed
by your organization's egress policy for this session. Do not retry or route
around it — report the blocked host."* Nenhuma tentativa de contorno foi feita
(§8.1: "não contornar bloqueios").

## Quem resolve e qual é o passo exato

| Quem | O quê |
|---|---|
| Responsável pelo ambiente de execução | liberar os 9 domínios abaixo na política de egresso, **ou** executar a ingestão em ambiente com saída para a internet pública |
| Operação do produto | depois da liberação: definir `INGESTION_ALLOWED_HOSTS` e rodar a sonda de acesso |

Domínios a liberar:

```
www.varzeagrande.mt.gov.br
emendas.varzeagrande.mt.gov.br
diariooficial.varzeagrande.mt.gov.br
amm.diariomunicipal.org
pncp.gov.br
api.portaldatransparencia.gov.br
api-publica.transferegov.gestao.gov.br
geoobras.tce.mt.gov.br
```

Nenhum outro trabalho foi interrompido por esse bloqueio: o esquema, o pipeline,
o motor de resposta, a API, a aplicação e os 87 testes foram entregues e
verificados (§1.3).

## Catálogo e situação de integração

`integration_status` é um campo do banco, não uma opinião no README. Nenhuma
fonte está `connector_verified`, e nenhuma está `enabled`.

| Código | Fonte | Papel esperado | Situação | Limitações registradas |
|---|---|---|---|---|
| F01 | Prefeitura Municipal de Várzea Grande | notícias, estrutura, caminhos | `access_probed` | cobertura histórica do arquivo não medida; notícia oficial não substitui registro administrativo (§8.1) |
| F02 | Portal da Transparência de VG | despesas, receitas, contratos, convênios | `access_probed` | é um índice: cada destino exige teste individual; o CNPJ 03.507.548/0001-10 é o ente principal, **não** a família completa de fundos e autarquias (§8.2) |
| F03 | Portal municipal de emendas | relações e registros de emendas | `access_probed` | escopo, paginação e acesso estruturado não validados |
| F04 | Diário Oficial de VG | atos, contratos, aditivos | `access_probed` | arquivo histórico e qualidade não medidos; edições antigas podem exigir OCR, que é último recurso (§13.2) |
| F05 | Jornal Oficial AMM-MT | publicações e histórico complementar | `access_probed` | não presumir que substitui todo o diário próprio (§8.2) |
| F06 | PNCP — dados abertos | contratações e documentos | `access_probed` | recorte e histórico a verificar; endpoints devem sair da documentação oficial, nunca de suposição (§8.3) |
| F07 | Portal da Transparência / CGU | emendas e execução federal | `access_probed` | **exige cadastro e token** conforme a documentação; limites de requisição a confirmar |
| F10 | Transferegov.br | instrumentos e transferências | `access_probed` | módulos, filtros e modelos a validar |
| F24 | Geo-obras Cidadão / TCE-MT | evidências sobre obras | **`blocked`** | ver abaixo |

### F24 é um bloqueio próprio, além do ambiente

O briefing registra (referência F24) que a tentativa de acesso ao caminho
indicado pelo Portal da Transparência municipal **já havia retornado rejeição**
na preparação do documento, e que não foi confirmada API, exportação ou coleta
automatizada utilizável.

Portanto: mesmo com a rede liberada, F24 continua sendo um bloqueio a resolver
com o TCE-MT, e não pode ser descrito como integração concluída (§24.2). Está
marcado `blocked` no banco.

## O que precisa acontecer depois da liberação

Na ordem do §24.2, e sem pular etapas:

1. rodar a sonda de acesso e registrar, por fonte: o que foi acessado, o que
   falhou e o que exige chave;
2. para cada fonte alcançada, preencher a ficha obrigatória do §8.4 — período
   **efetivamente** disponível, não o desejado;
3. construir um conector por vez, com teste de contrato e amostra reproduzível
   por outra pessoa (§F.1);
4. medir a matriz de cobertura do §9.3, distinguindo intervalo pedido de
   intervalo encontrado;
5. só então mudar `integration_status` para `connector_verified` e habilitar a
   fonte.

Uma fonte alcançável não é uma fonte integrada. Uma página que responde 200 não
prova que o conjunto de contratos foi atualizado (§8.4), e uma tabela vazia com
HTTP 200 pode ser filtro quebrado (§13.4, T27) — por isso
`assessEmptyBatch` existe e é testado.
