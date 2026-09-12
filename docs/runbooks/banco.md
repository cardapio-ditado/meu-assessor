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


## Postgres gerenciado (Supabase e equivalentes)

O esquema roda sem excecao de privilegio: nenhuma funcao `SECURITY DEFINER`,
nenhum papel com `BYPASSRLS`. Isso foi uma reescrita deliberada (D13), porque o
papel administrativo de um Postgres gerenciado nao e superusuario e nao pode
conceder `BYPASSRLS`.

**Use `db/bootstrap/`**: os arquivos la fazem exatamente os passos abaixo, sao
idempotentes e terminam com dois arquivos de verificacao que falham visivelmente
se algo estiver fora do lugar. O `03-provision.sql` e **gerado** a partir do
catalogo de fontes (`scripts/gen-provision.ts`), para que a situacao de
integracao nao divirja entre codigo e SQL — e o gerador se recusa a rodar se
alguma fonte estiver marcada como conector verificado.

Ordem de implantacao (a mesma de `db/bootstrap/README.md`):

1. **Criar o papel da aplicacao**, explicitamente sem privilegio de bypass:

   ```sql
   create role meu_assessor_app login nobypassrls nosuperuser nocreatedb nocreaterole;
   ```

2. **Aplicar as migracoes** `0001` a `0006` na ordem. Em banco compartilhado com
   outro produto, confira antes que o schema `ma` nao exista.

3. **Conceder o minimo** e nada fora do schema `ma`:

   ```sql
   grant usage on schema ma, extensions to meu_assessor_app;
   grant select, insert, update, delete on all tables in schema ma to meu_assessor_app;
   grant usage, select on all sequences in schema ma to meu_assessor_app;
   grant execute on all functions in schema ma to meu_assessor_app;
   alter default privileges in schema ma
     grant select, insert, update, delete on tables to meu_assessor_app;
   revoke create on schema ma from meu_assessor_app;
   ```

   Sem `create`: DDL e so por migracao.

4. **Definir a senha do papel** (nunca no repositorio, nunca em conversa):

   ```sql
   alter role meu_assessor_app password 'valor-gerado-no-cofre';
   ```

5. **Verificar o isolamento assumindo o papel**, nao como administrador:

   ```sql
   set role meu_assessor_app;
   select count(*) from ma.claims;              -- deve ser 0 sem contexto
   select rolbypassrls from pg_roles where rolname = current_user;  -- deve ser false
   ```

   Qualquer resultado diferente e incidente de configuracao, nao detalhe.

## Conexao em execucao serverless

Use a string do **pooler em modo transacao** do provedor, nao a conexao direta:
centenas de instancias frias esgotariam as conexoes do banco. O `pool.ts`
detecta o ambiente (`VERCEL` ou `MA_SERVERLESS`) e limita a uma conexao por
instancia.

`withContext` roda tudo dentro de uma transacao explicita com
`set_config(..., is_local => true)`, que e exatamente o que o modo transacao
suporta: o contexto morre com a transacao e nao vaza para a proxima requisicao
que reusar a conexao do pooler.

## Banco compartilhado com outro produto

Se o banco hospeda outro sistema no schema `public`:

- as extensoes vao para `extensions` quando esse schema existe (D17);
- o controle de migracoes vive em `ma.schema_migrations` (D18);
- o papel da aplicacao nao recebe privilegio de tabela fora de `ma`. Confirme:

  ```sql
  set role meu_assessor_app;
  select c.relname, has_table_privilege(current_user, c.oid, 'select')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';
  ```

  Todas as linhas devem trazer `false`. `USAGE` no schema costuma aparecer como
  concedido porque o provedor concede ao pseudo-papel `PUBLIC`; isso **nao**
  concede leitura de tabela, e revogar de `PUBLIC` afetaria o outro produto.
