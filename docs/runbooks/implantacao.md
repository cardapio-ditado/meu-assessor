# Runbook — implantacao

Estado desta implantacao: **ambiente de implantacao preparado, nao producao.**
O que falta para a palavra "producao" ser honesta esta na secao final.

## Arquitetura implantada

| Camada | Onde | Observacao |
|---|---|---|
| Aplicacao web (estaticos) | plataforma de hospedagem, a partir de `apps/web` | servidos pela plataforma, nao pela funcao |
| API `/v1/*` | funcao serverless, `api/index.js` -> `dist/` | mesmo handler do servidor local |
| Banco | Postgres gerenciado, schema `ma` | pooler em modo transacao |
| Coleta | **nao implantada** | exige agendador; ver limites |

## Variaveis de ambiente

Nenhuma tem valor padrao no codigo (§17.3). Sem elas, a aplicacao **recusa
login** em vez de funcionar com segredo embutido.

| Variavel | Obrigatoria | Conteudo |
|---|---|---|
| `DATABASE_URL` | sim | string do pooler em modo transacao, com o papel `meu_assessor_app` |
| `SESSION_SECRET` | sim | ao menos 32 caracteres aleatorios; assina o identificador de sessao |
| `DEMO_PASSWORD` | sim | senha de acesso do ambiente; sem ela nenhum login e aceito |
| `DEFAULT_TENANT_SLUG` | nao | organizacao padrao; `varzea-grande` no piloto |
| `DATABASE_SSL_NO_VERIFY` | nao | `1` quando o pooler do provedor nao apresenta cadeia verificavel |
| `AI_PROVIDER` | nao | `none` (padrao). Sem provedor o produto responde deterministicamente |
| `STT_PROVIDER` | nao | `none` (padrao). A rota de transcricao devolve 503 explicando, em vez de simular |
| `INGESTION_ALLOWED_HOSTS` | nao | vazio significa **nenhuma coleta externa**; e o padrao |

Gerar um `SESSION_SECRET`:

```bash
head -c 48 /dev/urandom | base64
```

## Passos

1. Aplicar o esquema e conceder o minimo: `docs/runbooks/banco.md`.
2. Definir a senha do papel da aplicacao e compor a `DATABASE_URL`. A senha
   **nao** passa por repositorio, ticket ou conversa.
3. Registrar as variaveis no cofre da plataforma.
4. Publicar. O build e `npm run build` (`tsc`); a saida estatica e `apps/web`.
5. Conferir o arranque: o log da funcao lista os avisos de configuracao
   (`configWarnings`). Nenhum aviso significa que as tres obrigatorias estao
   presentes.
6. Entrar com `admin.implantacao` e a `DEMO_PASSWORD`.

## O que a aplicacao deve mostrar depois de implantada

Com o banco provisionado e nenhuma fonte habilitada, o correto e:

- aviso **"nenhum conector de fonte publica esta em operacao"**;
- feed vazio, com a frase de que isso descreve o recorte carregado e nao a
  ausencia de acoes na administracao (§7.5);
- painel de fontes com as 9 do catalogo, todas `access_probed` ou `blocked`, e
  "ultima coleta com exito: nunca" marcado como defasado;
- qualquer pergunta respondida com **sem evidencia localizada**.

Isso nao e falha de implantacao. E a unica coisa verdadeira que o produto pode
dizer antes de a etapa E1 ser cumprida (§28.2: "nao simular execucao").

Se em vez disso aparecer conteudo, alguem carregou dado sintetico no ambiente de
implantacao — e isso **e** um incidente (§1.2).

## Criar contas do piloto

A implantacao traz **uma** conta, `admin.implantacao`. As contas dos usuarios
sao criadas pelo administrador municipal, porque o briefing exige autorizacao
antes de criar contas em nome de terceiros (§1.3):

```sql
insert into ma.users (login, display_name, job_title)
values ('<login>', '<nome>', '<cargo>');

insert into ma.user_grants (user_id, tenant_id, role, access_classes)
select u.id, t.id, 'manager', array['public']::ma.access_class[]
  from ma.users u, ma.tenants t
 where u.login = '<login>' and t.slug = 'varzea-grande';
```

Classes de acesso alem de `public` exigem decisao registrada: elas governam o
que a sessao consegue ler (§20.3).

## Revogar acesso

```sql
update ma.user_grants set revoked_at = now()
 where user_id = (select id from ma.users where login = '<login>');

-- Sessao aberta continua valida ate expirar: revogue tambem.
update ma.sessions set revoked_at = now() where user_login = '<login>';
```

Cache com conteudo restrito nao pode sobreviver a retirada de permissao
(§16.3, T34): ver `docs/runbooks/incidente.md`.

## O que falta para ser producao

Esta lista existe para que ninguem chame de producao o que ainda nao e (§28.2).

| Pendencia | Quem resolve |
|---|---|
| Etapa E1: acesso real as fontes, ainda bloqueado | responsavel pelo ambiente de rede |
| Extracao de PDF do diario oficial | engenharia, apos amostra real |
| Agendador persistente com duas execucoes reais registradas (R11, P0) | infraestrutura |
| Parecer juridico: LGPD, LAI, enquadramento de contratacao | juridico e encarregado |
| Separacao entre homologacao e producao (§17.3) | infraestrutura |
| Backup com **restauracao testada e medida** (§23.3) | infraestrutura |
| Avaliacao de acessibilidade WCAG 2.2 AA (R14, P0) | produto |
| Metas de latencia medidas no cenario declarado (§16.1) | engenharia |
| Banco dedicado: hoje compartilha projeto com outro produto | decisao do proprietario |

Enquanto essa lista tiver itens, o ambiente e de implantacao e demonstracao
tecnica — nao de uso com dado real de cidadao.
