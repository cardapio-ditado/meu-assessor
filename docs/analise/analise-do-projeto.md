# Análise do projeto Meu Assessor

Análise técnica e de produto do briefing v1.0 (12/09/2026) e do estado desta
implementação. Escrita para quem vai decidir se o piloto avança, com o quê e sob
quais condições.

---

## 1. O que o projeto é, em uma frase honesta

Um índice consultável de documentos públicos municipais, com uma camada de
explicação por cima e rastreabilidade obrigatória até a fonte.

Essa formulação importa porque duas descrições concorrentes aparecem com
frequência e ambas prometem demais: "IA que sabe tudo sobre a prefeitura" e
"chatbot da transparência". O produto real é mais estreito e mais defensável: ele
encurta o caminho entre a pergunta e a evidência. Quando a evidência não existe,
o produto correto **não responde**.

O briefing acerta nisso e é raro nesse acerto. A frase do §28.3 — "a IA deve
encurtar o caminho entre a pergunta e a evidência, nunca ocupar o lugar da
evidência" — é a especificação inteira comprimida.

## 2. A qualidade do briefing

É um documento de execução incomum. Três coisas o distinguem de um briefing de
produto típico:

**Separa o que foi dito do que foi proposto.** O §2.3 classifica cada item em
requisito do solicitante, contexto fornecido, proposta de implementação,
referência externa e pendente de validação. Isso é o oposto do padrão, em que a
proposta do fornecedor se disfarça de requisito do cliente.

**Antecipa o modo de falha específico deste produto.** A maioria dos briefings de
IA pede "não alucinar". Este pede algo muito mais preciso: não confundir
anunciado com empenhado com transferido com pago (§11.1); não transformar
presença em evento em autoria de emenda (§11.2); não somar fotografias de saldo
acumulado (§11.4); não deduzir execução física de pagamento integral (T19). Cada
um desses é um erro que um sistema plausível cometeria e que produziria dano
real, porque o erro *soa* correto.

**Recusa completude.** O §2.4 diz que a ausência na base não prova que o evento
não ocorreu, e o §9.3 define "completo" como uma afirmação sobre um universo
demonstrável, nunca sobre a realidade. Isso é a diferença entre um produto de
informação e um produto de aparência de informação.

### Onde o briefing é otimista

Três pontos merecem discussão franca antes de qualquer cronograma.

**A hipótese de valor não foi medida.** O §2.1 reconhece isso de forma explícita
("sua frequência e disposição de pagamento precisam ser medidas no piloto, não
apresentadas como pesquisa de mercado já realizada"), o que é honesto. Mas o
projeto inteiro repousa sobre a hipótese de que o gestor pergunta com frequência
suficiente para justificar manter uma base atualizada. Se a frequência real for
de poucas consultas por semana, o custo de curadoria por consulta respondida
fica alto, e a proposta se desloca de "assistente de consulta" para "preparação
de dossiês sob demanda" — que é um produto diferente, com outro preço e outra
operação.

**Dez anos de histórico é um projeto próprio.** O §9.1 já traduz isso com
cuidado, mas vale ser direto: a viabilidade da carga histórica depende quase
inteiramente da qualidade do arquivo digital de cada portal, e isso não é
conhecido. Diários oficiais municipais antigos com frequência são imagens
escaneadas sem texto nativo, o que joga o trabalho para OCR — que o próprio
briefing classifica como último recurso, com revisão de campos críticos
(§13.2). Um diário de 2016 em imagem pode custar mais em revisão humana do que
todo o resto do piloto.

**A cadeia de rastreabilidade completa será rara.** O §11.3 descreve oito elos
(emenda → instrumento → empenho → repasse → registro no executor → contratação
→ pagamento → execução) e admite que "nem todos os casos terão todos os elos".
Na prática, a expectativa razoável é que a cadeia completa seja a exceção, não a
regra, porque os elos vivem em sistemas de esferas diferentes que raramente
compartilham identificadores. O produto tem que ser bonito **exibindo lacunas**,
não apesar delas. É por isso que `assessChain` devolve as lacunas como
resultado de primeira classe e recusa ligações baseadas em semelhança de valor
ou data.

## 3. O que está sólido nesta implementação

**O motor financeiro.** É a parte mais valiosa e a mais testada. As oito etapas
são um enum, não uma convenção; `computeTotal` recusa somar etapas distintas,
devolve a fórmula e o universo junto do número, e lista o que excluiu e por quê.
O exemplo inteiramente fictício do §11.5 é um teste executável: a soma proibida
de R$ 1.950.000,00 é calculada explicitamente no teste e nenhum total do sistema
a produz.

**O isolamento.** `FORCE ROW LEVEL SECURITY` em 24 tabelas, papel de aplicação
sem `BYPASSRLS`, e testes que provam o isolamento contra o banco real. Há um
teste que falha se alguém conceder `BYPASSRLS` ao papel da aplicação — porque o
briefing cita exatamente esse modo de falha (F17), e uma nota no README não
impede ninguém de rodar `alter role`.

**O validador.** Roda depois da redação e antes da apresentação, e reduz ou se
abstém em vez de adicionar um aviso genérico. Confere se a referência existe no
conjunto recuperado **desta** consulta, se o valor citado bate com o campo
estruturado, se a autoria tem vínculo tipado de autoria, e se a evidência é do
município do contexto.

**Os dois eixos de tempo.** "Qual era o prazo em março?" e "o que sabíamos em
março?" são funções diferentes, e o recorte sintético tem uma versão retirada
mas preservada para provar as duas.

**A honestidade estrutural.** `integration_status` é uma coluna do banco com
cinco estados, e nenhuma fonte está `connector_verified`. A rota de transcrição
devolve 503 com explicação em vez de simular. Etapa financeira sem registro
aparece como "nenhum registro localizado", não como R$ 0,00.

### Três defeitos que os testes encontraram

Vale registrar porque mostram o tipo de erro que este domínio produz:

1. **A devolução era subtraída de todas as etapas.** Uma devolução de R$ 50 mil
   vinculada a um repasse aparecia como "Empenhado: −R$ 50.000,00". Uma anulação
   pertence à etapa do evento que ela cancela; sem esse vínculo ela não entra em
   total nenhum e vira ressalva. Foi corrigido e tem teste.

2. **IPv6 literal contornava a guarda de SSRF.** `URL.hostname` devolve IPv6
   entre colchetes (`[::1]`), então `isIP()` não reconhecia o endereço e a
   verificação de faixa bloqueada não rodava.

3. **A invalidação de cache só cobria a versão imediatamente anterior.** Uma
   resposta em cache montada sobre a versão 1 de um documento sobrevivia à
   chegada da versão 3.

Nenhum dos três seria pego por inspeção visual da resposta: todos produzem saída
plausível.

## 4. O que está frágil ou ausente

| Área | Situação | Risco |
|---|---|---|
| Acesso às fontes reais | bloqueado pelo ambiente | **alto** — é a etapa E1; nada sobre cobertura real pode ser afirmado |
| Extração de PDF | não implementada | **alto** — o diário oficial é a fonte mais importante e a mais difícil; texto nativo vs. OCR muda o custo do projeto |
| Busca semântica | não implementada (pgvector ausente no ambiente) | baixo — o §15.1 a descreve como complementar; FTS em português + trigrama cobre o piloto |
| Síntese por modelo de linguagem | não implementada; produto opera determinístico | médio — a camada 1 hoje é montada por regra, o que é legível mas rígido |
| Transcrição de voz | gravação funciona no navegador; transcrição não | médio — é requisito P0 (R13) |
| Rotina automática | nenhum agendador existe | **alto** — R11 é P0 e exige duas execuções reais registradas |
| Exportação de dossiê | não implementada | baixo — P1 (R20) |
| Parecer jurídico | pendente | **alto** — condição de produção, não de piloto técnico |
| Elegibilidade WhatsApp | não avaliada | baixo se o produto não depender do canal, o que o §10.2 do briefing garante |
| Acessibilidade | WCAG 2.2 AA como referência; sem avaliação | médio — R14 é P0 e exige usuários reais completando tarefas |

O item que mais deve preocupar não é nenhuma funcionalidade: é a **extração de
PDF do diário oficial**. Ela determina se o produto consegue responder sobre
atos administrativos, que é a espinha dorsal da proposta. Até que uma amostra
real de edições de anos diferentes seja avaliada, qualquer estimativa de prazo
ou custo é chute.

## 5. Riscos reais, na ordem em que mordem

**1. O produto parecer melhor do que é.** É o risco central e o briefing tem
razão em dedicar tanto espaço a ele. Uma interface limpa com uma resposta curta
e confiante sobre um dado velho é pior que nenhuma resposta, porque o gestor vai
repeti-la em público. A defesa não é um aviso no rodapé: é o conjunto de regras
que impede a frase de sair. A `freshness_class` por campo, e não um selo verde
por dossiê, é a decisão que faz isso funcionar.

**2. Atribuição indevida de autoria.** Um erro aqui tem consequência política
imediata e não é reversível por errata. É por isso que `relation_type` tem 13
valores e que menção em notícia é um valor distinto de autoria, com o validador
recusando a conversão.

**3. Dupla contagem financeira.** Um número inflado numa entrevista é um dano
concreto. O mesmo repasse publicado em dois portais, o saldo acumulado somado
como fluxo, a emenda coletiva multiplicada por integrante — todos produzem
números altos e plausíveis. Todos têm teste.

**4. Confusão institucional e político-partidária.** O §20.2 é o parágrafo mais
importante do briefing para a sobrevivência do produto. O caso de origem envolve
um gestor que também participa de atividades políticas, e a mistura de bases,
usuários, financiamento e finalidade transformaria uma ferramenta administrativa
em passivo jurídico. Isso é decisão de governança e contrato, não de código, e
não pode ser resolvido por quem escreve o software.

**5. Custo de curadoria subestimado.** O §23.5 acerta ao dizer que a margem não
pode ser calculada apenas sobre tokens. O custo dominante provável não é modelo
de linguagem: é gente resolvendo a fila de revisão quando a automação não
conseguiu vincular um contrato a uma obra. Esse custo escala com a qualidade do
portal de cada cidade, não com o número de consultas — o que tem consequência
direta no modelo de preço por município.

**6. Dependência de uma pessoa.** A operação proposta no §21.1 concentra
validação de utilidade, linguagem e experiência em uma pessoa. Para um piloto
está bem; para replicação, é o gargalo.

## 6. Recomendações

**Antes de qualquer cronograma:**

1. Desbloquear a rede e cumprir E1 de verdade. Sem isso, prazo é ficção.
2. Pegar **uma amostra real** de 20 edições do diário oficial, distribuídas em
   anos diferentes, e medir: quantas têm texto nativo, quantas exigem OCR, e
   qual a taxa de erro do OCR em números e nomes. Esse número único reordena
   todo o resto do projeto.
3. Cadastrar a família de entidades do município — fundos, autarquias, unidades
   destinatárias — antes de calcular qualquer total de "recursos da cidade". O
   CNPJ do ente principal não basta (§8.2), e um repasse a fundo municipal com o
   favorecido trocado pela prefeitura é um erro silencioso.

**No piloto:**

4. Medir o que o §26.2 pede, e medir a **compreensão**, não só o uso. O teste do
   §22.4 — perguntar ao usuário "o dinheiro já entrou?" e "essa obra terminou?"
   depois de ele ler a tela — vale mais que qualquer métrica de engajamento. Se
   a interface induz a inferência errada, o produto falhou mesmo estando correto.
5. Escolher o recorte inicial por **densidade documental**, não por importância
   política. Um tema com documentação completa prova a cadeia vertical; um tema
   importante com documentação esparsa só produz lacunas.
6. Manter a rotina automática como critério de liberação, não como item
   posterior. O §28.2 é explícito: um agendamento descrito mas não executado não
   é pronto, e um aplicativo que só funciona enquanto a sessão do agente está
   aberta também não.

**Sobre escopo:**

7. Tratar a síntese por modelo de linguagem como **melhoria**, não como base. O
   produto determinístico atual já responde, cita e recusa. Adicionar um modelo
   melhora a fluência do resumo; não deveria ser o que faz o produto funcionar.
   Essa ordem também protege o orçamento: o §17.4 lembra que a assinatura pessoal
   de um chat não é orçamento de aplicação.
8. Não perseguir o WhatsApp agora. O §19.4 mostra que a elegibilidade é incerta e
   que trocar o nome da conta não resolve. A decisão arquitetural de manter o web
   app com microfone como produto principal já neutraliza esse risco — e deve
   ser mantida mesmo se o canal for aprovado depois.
9. Adiar a expansão para o segundo município até que a implantação do primeiro
   esteja documentada como procedimento repetível. O §25.2 tem razão: a escala
   depende da capacidade de manter conectores, não de duplicar uma tela.

## 7. Resumo

O briefing é bom e a especificação é executável. O núcleo difícil — separar
etapas financeiras, não confundir tipos de vínculo, preservar dois eixos de
tempo, isolar organizações, recusar responder sem evidência — está implementado
e testado, com 87 testes e três defeitos reais corrigidos no caminho.

O que falta não é principalmente código. É **acesso**: às fontes, a uma amostra
real do diário oficial, e a um parecer jurídico. Enquanto o acesso não existir, o
honesto é dizer que existe uma base sólida e uma etapa E1 não cumprida — e não
apresentar a demonstração sintética como prova de cobertura.

A frase que deveria governar a próxima etapa é a do §28.3: construa primeiro um
caminho pequeno que seja verdadeiro, rápido e verificável; amplie a cobertura sem
perder essas propriedades.
