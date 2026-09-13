# Prova de acesso às fontes — E1 (§24.2)

## Resultado: 8 das 9 fontes alcançadas (2026-09-13)

| | |
|---|---|
| Execução | workflow **Prova de acesso as fontes (E1)**, disparo manual — [run 34757007445](https://github.com/cardapio-ditado/meu-assessor/actions/runs/34757007445) |
| Ferramenta | `scripts/prova-acesso.ts`, usando `fetchGuarded` — **o mesmo cliente da coleta**, não um `curl` mais permissivo |
| Ambiente | runner `ubuntu-latest` do GitHub Actions |
| Agente | `MeuAssessor/0.1 (prova de acesso E1; +https://github.com/cardapio-ditado/meu-assessor)` |
| Volume | uma requisição por fonte, sem retentativa, com intervalo entre elas |

| Código | Fonte | Endereço sondado | Desfecho | Tempo |
|---|---|---|---|---|
| F01 | Prefeitura Municipal de Várzea Grande | `https://www.varzeagrande.mt.gov.br/` | **200** | 4207 ms |
| F02 | Portal da Transparência de VG | `https://www.varzeagrande.mt.gov.br/transparencia` | **200** | 2759 ms |
| F03 | Portal municipal de emendas | `https://emendas.varzeagrande.mt.gov.br/portal` | **200** | 1894 ms |
| F04 | Diário Oficial de VG | `https://diariooficial.varzeagrande.mt.gov.br/` | **200** | 1477 ms |
| F05 | Jornal Oficial AMM-MT | `https://amm.diariomunicipal.org/` | **200** | 750 ms |
| F06 | PNCP | `https://pncp.gov.br/api/consulta/swagger-ui/index.html` | **200** | 2611 ms |
| F07 | Portal da Transparência / CGU | `https://api.portaldatransparencia.gov.br/swagger-ui/index.html` | **200** | 1015 ms |
| F10 | Transferegov.br | `https://api-publica.transferegov.gestao.gov.br/` | **200** | 2528 ms |
| F24 | Geo-obras Cidadão / TCE-MT | `https://geoobras.tce.mt.gov.br/` | falhou | 21 685 ms |

Nenhum `robots.txt` proibiu o caminho sondado. A consulta a `robots.txt`
acontece **antes** da requisição à página, e um caminho proibido não é
requisitado.

### Por que estes desfechos valem

Os controles neutros da mesma execução — `example.com` e `www.gov.br` —
responderam **200**. É isso que autoriza atribuir os desfechos às fontes.

Sem esse cuidado a conclusão se inverte sozinha: a tentativa anterior, abaixo,
produziu "9 de 9 bloqueadas" quando nenhum portal havia sido contatado. O script
recusa afirmar desfecho por fonte quando os controles falham.

### F24: o único que não respondeu

Não respondeu em 25 s, enquanto as outras oito fontes e os dois controles
responderam na mesma execução. Uma falha isolada **não** separa indisponibilidade
momentânea de bloqueio por origem ou filtro de rede — reexecutar o workflow em
outro horário é o teste barato que distingue os dois.

Somada à rejeição que o briefing já registra na preparação (referência F24),
mantém-se `blocked`. Continua sendo assunto a resolver com o TCE-MT, não uma
integração pendente de código.

### O que esta prova estabelece — e o que não

**Estabelece:** o endereço de oito fontes respondeu, em data registrada, a partir
de uma rede pública, com o cliente de coleta do produto e respeitando o
`robots.txt` declarado.

**Não estabelece, e a diferença é a do §C.2:**

- que exista conector — nenhuma fonte está `connector_verified`;
- que o recorte histórico esteja disponível (§8.4) — nada disso foi medido;
- cobertura de campos, paginação, estabilidade de contrato;
- **no caso do F07, acesso aos dados**: o que respondeu 200 foi a página de
  documentação. A API da CGU exige cadastro e token, então o acesso aos dados
  continua não demonstrado.

Uma página que responde 200 não prova que o conjunto de contratos foi
atualizado, e uma tabela vazia com HTTP 200 pode ser filtro quebrado (§13.4,
T27) — por isso `assessEmptyBatch` existe e é testado.

## Tentativa anterior, e por que não valia (2026-09-12)

Fica registrada porque distingue "não sabemos" de "o portal não responde".

Executada de dentro do contêiner de execução deste repositório, as 9 fontes
falharam com **403 no CONNECT** do proxy de egresso. No mesmo instante,
`example.com` e `planalto.gov.br` falharam do mesmo modo, enquanto
`registry.npmjs.org`, `pypi.org` e `api.github.com` responderam 200: a política
de rede do ambiente permite uma allowlist estreita e recusa o resto.

Nenhuma tentativa de contorno foi feita (§8.1). A própria documentação do proxy
instrui a relatar o host bloqueado em vez de rotear em volta.

**A lição virou código.** Aquele resultado, lido sem controles, diria "nove
portais bloqueados" — uma afirmação falsa sobre nove órgãos públicos, do tipo
que alguém copia para um relatório. Os controles neutros do
`scripts/prova-acesso.ts` existem por causa disso.

## Quem resolve e qual é o passo exato

O bloqueio de rede continua valendo **para o contêiner de execução**, e deixou
de ser impedimento porque a sondagem roda em outro lugar.

| Quem | O quê |
|---|---|
| Operação do produto | disparar o workflow *Prova de acesso as fontes (E1)* quando quiser reverificar; o relatório sai no resumo da execução e como artefato |
| Responsável pelo ambiente de execução | **somente se** a coleta tiver de rodar de dentro deste contêiner: liberar os domínios abaixo na política de egresso |

Domínios das fontes:

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

## Catálogo e situação de integração

`integration_status` é um campo do banco, não uma opinião no README. Nenhuma
fonte está `connector_verified`, e nenhuma está `enabled` — alcançar o endereço
não muda nenhuma das duas coisas, e é por isso que a coluna abaixo continua em
`access_probed` depois de uma sondagem bem-sucedida.

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

## O que vem depois da E1

Na ordem do §24.2, e sem pular etapas. O passo 1 está feito — é o que este
documento registra:

1. ~~rodar a sonda de acesso e registrar, por fonte: o que foi acessado, o que
   falhou e o que exige chave~~ — **feito em 2026-09-13**;
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
