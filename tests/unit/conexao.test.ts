/**
 * A DATABASE_URL malformada precisa se explicar.
 *
 * Sem esta checagem o driver conecta no que conseguiu interpretar e o erro
 * chega como `getaddrinfo EAI_AGAIN hostname: "base"` — parece falha de rede e
 * manda quem implanta investigar DNS, firewall e regiao do banco. Aconteceu na
 * primeira coleta real.
 *
 * A outra metade do teste importa tanto quanto: a mensagem nao pode vazar a
 * string nem a senha (17.3), porque ela costuma ir para um log publico junto
 * com o erro.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { conferirFormato } from '../../packages/db/src/pool.ts';

const SENHA = 'S3nh4-Muito-Secreta';

describe('formato da DATABASE_URL', () => {
  test('aceita a string do pooler', () => {
    assert.doesNotThrow(() =>
      conferirFormato(
        `postgresql://meu_assessor_app.abc:${SENHA}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`,
      ),
    );
  });

  test('recusa marcador de senha nao substituido, colchetes inclusive', () => {
    assert.throws(
      () => conferirFormato('postgresql://user:[YOUR-PASSWORD]@host:6543/postgres'),
      /marcador de senha/,
    );
  });

  test('recusa linha colada inteira, do tipo `DATABASE_URL=...`', () => {
    assert.throws(() => conferirFormato('DATABASE_URL = postgresql://u:p@h:5432/postgres'), /URL/);
  });

  test('recusa o que nao comeca com postgresql://', () => {
    assert.throws(() => conferirFormato('https://exemplo.test/banco'), /postgresql:\/\//);
  });

  test('recusa string sem nome de banco', () => {
    assert.throws(() => conferirFormato('postgresql://u:p@host:6543'), /sem nome de banco/);
  });

  test('a mensagem NUNCA contem a senha nem a string inteira', () => {
    const url = `postgresql://user:${SENHA}@host:6543`;
    try {
      conferirFormato(url);
      assert.fail('deveria ter recusado');
    } catch (erro) {
      const mensagem = (erro as Error).message;
      assert.ok(!mensagem.includes(SENHA), 'a senha vazou na mensagem');
      assert.ok(!mensagem.includes(url), 'a string inteira vazou na mensagem');
      // Mas precisa ser util: o host ajuda a identificar qual string e.
      assert.match(mensagem, /host/);
    }
  });
});
