# Bootstrap de um Postgres gerenciado

Ordem de aplicacao para um projeto novo (Supabase, RDS, Neon):

| Passo | Arquivo | Roda como |
|---|---|---|
| 1 | `01-role.sql` | papel administrativo do provedor |
| 2 | `../migrations/0001..0006` | papel administrativo |
| 3 | `02-grants.sql` | papel administrativo (depois das migracoes: concede sobre tabelas que ja existem) |
| 4 | `03-provision.sql` | papel administrativo |
| 5 | `04-verify.sql` | papel administrativo, que assume o papel da aplicacao |
| 6 | senha do papel | operador, fora de repositorio e fora de conversa |

Passo 6, sempre por ultimo e nunca aqui:

```sql
alter role meu_assessor_app password '<valor gerado no cofre>';
```

Todos os arquivos sao **idempotentes**: aplicar duas vezes nao duplica nada e
nao derruba o que existe. Isso importa porque provisionamento e a hora em que
alguem repete um passo por engano.

O que este bootstrap **nao** faz, de proposito:

- nao carrega dado sintetico (§1.2: dado ficticio so em demonstracao e teste);
- nao habilita nenhuma fonte (§8.1: ativar conector e decisao de operacao
  autorizada, apos o checklist F.1);
- nao cria contas em nome de terceiros (§1.3): cria uma unica conta de
  implantacao, e as contas do piloto sao criadas pelo administrador municipal.
