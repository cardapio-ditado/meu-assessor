# Runbook — banco de dados

## Criar o banco de um ambiente

O ponto critico esta no primeiro comando: **o papel da aplicacao nao pode ter
`BYPASSRLS` nem ser superusuario.** Com qualquer um dos dois, todas as politicas
de isolamento do `0005_rls.sql` deixam de valer e o produto passa a servir dados
de uma organizacao para outra sem erro nenhum (F17, §20.3).

```bash
createuser meu_assessor_app --no-superuser --no-createdb --no-createrole
psql -c "alter role meu_assessor_app nobypassrls login password '<segredo>'"
createdb meu_assessor -O meu_assessor_app
psql -d meu_assessor -c 'create extension pgcrypto; create extension pg_trgm; create extension unaccent;'
```

Verificacao (o teste de integracao faz isso automaticamente):

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'meu_assessor_app';
-- esperado: f | f
```

## Aplicar migracoes

```bash
DATABASE_URL=... npm run db:migrate
```

Cada arquivo roda em **uma transacao** e e registrado em
`public.schema_migrations` com o hash do conteudo. Consequencias:

- falha parcial nao deixa esquema meio aplicado;
- editar um arquivo ja aplicado e **erro**, nao reaplicacao silenciosa. Crie uma
  nova migracao.

`0006_authn_path.sql` cria um papel e precisa ser aplicada por um superusuario:

```bash
psql -d meu_assessor -f db/migrations/0006_authn_path.sql
```

## Confirmar o isolamento

```sql
-- Todas as tabelas de conteudo precisam ter RLS habilitado E forcado.
select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'ma' and c.relkind = 'r'
 order by c.relforcerowsecurity, c.relname;
```

Qualquer linha com `relforcerowsecurity = f` numa tabela com `tenant_id` e um
incidente de configuracao.

```bash
DATABASE_URL=... npm run test:integration
```

## Contexto da requisicao

Nenhuma leitura de conteudo acontece fora de `withContext`. A funcao grava
`ma.tenant_id`, `ma.access_classes` e `ma.user_id` com
`set_config(..., is_local => true)` dentro da mesma transacao, para que o valor
morra com ela e nao contamine a conexao devolvida ao pool.

`withoutTenant` existe apenas para autenticacao, operacao de plataforma e
migracao. Sob RLS, ela **nao le conteudo de cliente** — ha um teste que verifica
exatamente isso.

## Restaurar backup

Nao executado nesta entrega. §23.3 exige que uma restauracao real seja executada
e medida **antes** de qualquer SLA comercial. O procedimento deve terminar
verificando que dossies, fontes, vinculos e permissoes continuam consistentes
(T48), nao apenas que o `pg_restore` terminou sem erro.
