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
