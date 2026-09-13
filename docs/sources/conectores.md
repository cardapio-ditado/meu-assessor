# Conectores escritos

Este documento existe para separar três coisas que costumam ser ditas como se
fossem uma só (§C.2):

- **página localizada** — o endereço é conhecido;
- **acesso comprovado** — alguém pediu e a fonte respondeu, com data e desfecho;
- **conector escrito** — há código que lê a resposta real e a transforma em
  conteúdo consultável.

Nenhuma fonte deste repositório está marcada como `connector_verified`, e
nenhuma está `enabled`. Habilitar um conector é decisão de operação autorizada
depois do checklist F.1, não consequência de o código existir (§8.1).

---

## F06 — PNCP, contratos

- **Endpoint:** `GET https://pncp.gov.br/api/consulta/v1/contratos`
- **Recorte:** por CNPJ do órgão e janela de **data de publicação no PNCP**.
- **Chave de deduplicação:** `numeroControlePNCP`.
- **Execução:** workflow *Coletar contratos do PNCP (F06)*, com `de` e `ate`.

O que a fonte **não** dá: pagamento. Contrato assinado não é dinheiro pago
(§11.1); nenhuma afirmação deste conector fala em valor pago.

Cuidado registrado: `dataAssinatura` e `dataPublicacaoPncp` são papéis
diferentes e, neste município, chegam a ficar meses distantes. Confundi-las faz
o contrato aparecer no período errado (§12.2).

---

## F10 — Transferegov, transferências especiais

- **Endpoints:**
  - `GET https://api-publica.transferegov.gestao.gov.br/especiais/beneficiarios-especiais`
  - `GET https://api-publica.transferegov.gestao.gov.br/especiais/planos-acao-especiais`
- **Recorte:** todos os planos de ação do beneficiário. A fonte **não** oferece
  filtro por data, então não há janela — e a matriz de cobertura registra
  período pedido nulo em vez de um recorte inventado (§9.3).
- **Chave de deduplicação:** `id_plano_acao`.
- **Execução:** workflow *Coletar transferências especiais (F10)*, sem parâmetros.

### O que este conector cobre, e o que não cobre

A API tem quatro módulos: `downloads`, `especiais`, `fundoafundo` e
`parcerias`. **Só `especiais` tem conector.** Convênios e contratos de repasse
são distribuídos como CSV em `/downloads`, não por API, e não são coletados.

Dizer "temos Transferegov" seria, portanto, afirmação maior que o fato. O
conjunto de dados chama-se `planos-acao-especiais` exatamente para que a
cobertura não prometa mais do que entrega.

### Como o município é encontrado

O endpoint de planos de ação **não aceita** nome nem CNPJ de município. O
vínculo é por `id_beneficiario`, obtido em `/beneficiarios-especiais` a partir
do CNPJ (§10.3: ligar por identificador oficial, nunca por semelhança de nome).

Se a consulta por CNPJ devolver zero ou mais de um beneficiário, a coleta
**para**. Escolher um deles por conta própria seria adivinhar de quem é o
dinheiro.

### Duas armadilhas encontradas em execução, não supostas

1. **Sintaxe do filtro.** A primeira tentativa usou a sintaxe de operador do
   PostgREST (`cnpj_beneficiario=eq.03507548000110`). A API respondeu **200 com
   lista vazia** — o filtro foi aplicado sobre um literal inexistente. Uma lista
   vazia não parece erro; por isso há um teste que trava a forma correta (valor
   cru).
2. **O caminho é `planos-acao`, não `plano-acao`.** Procurar pelo nome errado
   na especificação devolveu zero endpoints, o que é indistinguível de "o
   recurso não existe".

### O que a fonte dá e o que não dá

| Campo | Situação |
|---|---|
| `valor_investimento_plano_acao`, `valor_custeio_plano_acao` | valores do plano, em centavos exatos |
| valor total | **soma** das duas parcelas, com qualificador dizendo isso |
| `data_aceite_plano_acao` | única data do plano |
| data de publicação | **a fonte não publica** — o campo fica nulo, não é preenchido com o aceite (§12.2) |
| `nome_objeto`, `detalhamento_objeto` | vieram **vazios** em todos os planos deste município |
| emenda de origem | número, ano e código do parlamentar |

Sobre o objeto vazio: o conector **não** o substitui pela área de política
pública. A área diz o setor; não diz o que foi feito. Preenchê-la ali seria
inventar conteúdo que a fonte não deu.

Sobre zero: `valor_custeio` vem `0.0` quando a emenda é toda de investimento.
Esse zero **é um valor** e fica registrado como zero. Valor ausente, ou que não
caiba em centavos exatos, vira `null` com motivo — nunca zero (§10.4). E o
total não é calculado quando qualquer parcela é desconhecida: somar com uma
parcela faltando daria um número menor que o real, com cara de número conferido.

### Estágio do dinheiro

Um plano de ação aceito diz que o recurso foi **destinado**. Não diz empenhado,
não diz transferido, não diz pago (§11.1). Todas as afirmações de valor deste
conector carregam esse qualificador, e o texto guardado termina com a frase em
português para quem lê a tela.

Empenho, ordem bancária e devolução existem em outros endpoints do mesmo módulo
(`/empenhos-especiais`, `/ordens-pagamentos-ordens-bancarias-especiais`,
`/devolucao-especiais`) e são o próximo passo natural — hoje **não coletados**.

### Emenda e parlamentar

A fonte declara de qual emenda o plano veio, com identificador. Isso **não** é
relação de autoria: nenhuma relação tipada entre parlamentar e obra é criada
(§A.5). O nome do parlamentar entra como qualificador da afirmação sobre a
emenda, junto do código dele, com o vínculo descrito em texto.

### O que não é guardado, de propósito

Dados bancários (`numero_conta_plano_acao`, agência, dígitos, `id_agencia_conta`)
e `email_camara` **não** entram no banco nem no texto indexado. São dados
abertos de ente público, mas nenhuma pergunta que este produto responde precisa
deles, e o que não é guardado não vaza. Há teste que falha se voltarem.

---

## F04 — Diário Oficial de Várzea Grande, edições

- **Páginas:** `https://diariooficial.varzeagrande.mt.gov.br/edicoes` (listagem) e
  `/edicao/{id}` (uma edição, com o link do PDF).
- **Recorte:** as N edições mais recentes (padrão 10), ou uma janela `--de`/`--ate`
  por data de publicação.
- **Chave de deduplicação:** o **id interno do portal**, não o número da edição.
- **Execução:** workflow *Coletar Diário Oficial de VG (F04)*.

### Texto nativo, sem OCR

Antes de escrever qualquer coisa, a edição 539 foi diagnosticada (execução
34763480181): **24 páginas, 153 `/Font`, 20 `/FontFile2`, 20 `/ToUnicode`, 7.127
operadores de texto** e apenas 4 imagens. É documento de texto, não digitalização.
OCR é último recurso (§13.2) e **não foi necessário**.

A extração usa `pdfjs-dist` e não um extrator próprio. O motivo é o `/ToUnicode`:
fonte embutida em subconjunto não usa ASCII nos fluxos, usa índice de glifo, e só
o mapa diz qual caractere é qual. Um extrator ingênuo acerta as fontes de
codificação padrão e devolve **lixo plausível** nas outras — e lixo plausível é o
pior desfecho possível aqui, porque a evidência do §12.1 é um trecho que alguém
vai ler e conferir. Texto embaralhado que parece texto passa por revisão e vira
citação falsa.

### Três armadilhas encontradas em execução

1. **O número da edição não é único.** Na listagem real, a edição **538 aparece
   duas vezes no mesmo dia** — uma "Normal" e uma "Suplemento", com endereços
   diferentes. Deduplicar por número fundiria as duas e uma sumiria. A chave é o
   id de `/edicao/{id}`, e há teste travando isso.
2. **O nome do arquivo PDF não segue a data.** `013_edicao_539_DOM.pdf` está na
   pasta `07-Julho` e a edição é de **10/07/2026**: o `013` é o décimo terceiro
   arquivo do mês, não o dia. O endereço é **lido** da página, nunca montado
   (§8.3) — um padrão deduzido baixaria o diário de outro dia.
3. **Página sem texto fica registrada.** Um encarte de imagem no meio do diário é
   um pedaço que **não foi lido**; a afirmação de número de páginas carrega a
   ressalva com quais páginas foram (§9.3), e a edição vai para
   `requires_review`.

### O defeito que a primeira coleta revelou

A primeira coleta gravou, no banco, `Diário O昀椀cial` e `o 昀氀uxo` — ligaduras `fi`
e `fl` viradas ideogramas. **Não é falha do leitor**: o mapa `ToUnicode` gravado
no arquivo desalinha os bytes UTF-16 da ligadura, e copiar e colar num leitor de
PDF reproduz o mesmo. O padrão é exato:

| Sai | Codepoint | Byte alto | Era |
|---|---|---|---|
| 昀 | U+6600 | `0x66` | `f` |
| 椀 | U+6900 | `0x69` | `i` |
| 氀 | U+6C00 | `0x6C` | `l` |

O byte da letra foi parar no byte **alto** de um caractere de 16 bits e o baixo
ficou zero. O conserto devolve o byte alto, sob regra deliberadamente estreita:
só quando o byte baixo é zero **e** o alto é letra ASCII. Isso cobre todas as
ligaduras que existem (fi, fl, ff, ffi, ffl) e não encosta em símbolos legítimos
que também têm byte baixo zero, como ∀ (U+2200) ou ✀ (U+2700) — consertar demais
seria trocar um texto errado por outro.

Isto importava mais do que parece: o texto corrompido é **invisível para a
busca**. Quem procurasse "Diário Oficial" não acharia "Diário O昀椀cial", a tela
ficaria vazia e ninguém investigaria uma coleta bem-sucedida.

### Ancoragem da evidência

O texto guardado leva marcas `[pagina N]`. Sem elas, a evidência de um documento
de 24 páginas seria "está em algum lugar do diário", que não é ancoragem nenhuma.
O localizador diz página, total, número da edição, tipo, data e o arquivo.

### O que este conector NÃO faz

**Não extrai os atos de dentro da edição.** Portaria, extrato de contrato e
aditivo são texto corrido no PDF. Transformar isso em afirmação tipada exige um
extrator de ato testado caso a caso; por regex apressada, produziria "contrato"
com valor e fornecedor **plausíveis e errados** — o defeito mais caro que este
produto pode ter.

Então: a edição entra como **documento consultável por busca em texto**, e as
afirmações são sobre a **edição** (número, data, tipo, número de páginas,
arquivo), não sobre os atos. Afirmar menos é o que permite afirmar com evidência.

Uma consequência de modelagem: a edição recebeu o tipo de entidade
`official_publication`, criado para ela (migração 0008). `news_item` faria a
edição aparecer como notícia na tela — afirmando sobre o município algo que a
fonte não diz.

