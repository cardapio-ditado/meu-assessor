/**
 * O 7.2 exige que a recusa de login nao revele se a conta existe: a resposta ao
 * cliente tem de ser IDENTICA qualquer que seja a causa. O 23.1 exige que a
 * operacao consiga diagnosticar. As duas coisas convivem — o motivo vai para o
 * log do servidor, nunca para o corpo — e este arquivo existe porque elas se
 * quebram em direcoes opostas:
 *
 *  - quem acrescenta diagnostico tende a vaza-lo no corpo ("usuario nao
 *    encontrado"), e ai o 7.2 cai;
 *  - quem protege o 7.2 tende a engolir o erro inteiro, e ai a operacao fica
 *    sem saber se o login falhou por senha, por conta sem concessao ou porque o
 *    banco esta fora. Foi o que aconteceu na implantacao: descobrir qual dos
 *    tres exigiu ler o log do Postgres procurando uma conexao no mesmo segundo.
 *
 * Nao precisa de banco: as tres causas cobertas aqui sao decididas antes de
 * qualquer consulta, e a quarta usa um endereco que recusa conexao na hora.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { handle } from '../../services/api/src/app.ts';

const SENHA = 'senha-de-teste-do-ambiente';
const SEGREDO = 'a'.repeat(48);

let server: Server;
let base: string;
const registrado: string[] = [];
const erroOriginal = console.error;

before(async () => {
  server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.error = (...args: unknown[]) => {
    registrado.push(args.map(String).join(' '));
  };
});

after(async () => {
  console.error = erroOriginal;
  server.close();
  await once(server, 'close');
});

interface Recusa {
  status: number;
  corpo: string;
  requestId: string;
  log: string;
}

async function tentarLogin(corpoEnviado: Record<string, unknown>): Promise<Recusa> {
  registrado.length = 0;
  const resposta = await fetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpoEnviado),
  });
  return {
    status: resposta.status,
    corpo: await resposta.text(),
    requestId: resposta.headers.get('x-request-id') ?? '',
    log: registrado.join('\n'),
  };
}

describe('7.2 - a recusa de login e uniforme para o cliente', () => {
  test('as causas distintas produzem a MESMA resposta', async () => {
    // Causa 1: ambiente sem senha configurada.
    delete process.env['DEMO_PASSWORD'];
    process.env['SESSION_SECRET'] = SEGREDO;
    const semSenhaConfigurada = await tentarLogin({ login: 'admin.implantacao', password: 'x' });

    // Causa 2: ambiente sem segredo de sessao.
    process.env['DEMO_PASSWORD'] = SENHA;
    process.env['SESSION_SECRET'] = 'curta-demais';
    const semSegredo = await tentarLogin({ login: 'admin.implantacao', password: SENHA });

    // Causa 3: senha incorreta.
    process.env['SESSION_SECRET'] = SEGREDO;
    const senhaErrada = await tentarLogin({ login: 'admin.implantacao', password: 'nao-e-essa' });

    // Causa 4: conta que nao existe, com a senha CERTA. Este e o caso que o
    // 7.2 protege: nao pode ser distinguivel do anterior.
    process.env['DATABASE_URL'] = 'postgres://ninguem:nada@127.0.0.1:1/inexistente';
    const contaInexistente = await tentarLogin({ login: 'nao.existe', password: SENHA });

    const casos = [semSenhaConfigurada, semSegredo, senhaErrada, contaInexistente];
    for (const caso of casos) {
      assert.equal(caso.status, 401);
      assert.equal(caso.corpo, semSenhaConfigurada.corpo, 'o corpo precisa ser identico');
    }
    // Nada no corpo pode sugerir a causa.
    for (const vazado of ['senha', 'DEMO_PASSWORD', 'SESSION_SECRET', 'concess', 'banco', 'login']) {
      assert.ok(
        !senhaErrada.corpo.toLowerCase().includes(vazado.toLowerCase()),
        `o corpo nao pode citar "${vazado}"`,
      );
    }
  });
});

describe('23.1 - o servidor registra a causa que o cliente nao ve', () => {
  test('cada causa deixa um motivo distinto no log, com o identificador da requisicao', async () => {
    process.env['SESSION_SECRET'] = SEGREDO;

    delete process.env['DEMO_PASSWORD'];
    const semSenhaConfigurada = await tentarLogin({ login: 'a', password: 'b' });
    assert.match(semSenhaConfigurada.log, /DEMO_PASSWORD nao definida/);

    process.env['DEMO_PASSWORD'] = SENHA;
    process.env['SESSION_SECRET'] = 'curta';
    const semSegredo = await tentarLogin({ login: 'a', password: SENHA });
    assert.match(semSegredo.log, /SESSION_SECRET ausente ou com menos de 32 caracteres/);

    process.env['SESSION_SECRET'] = SEGREDO;
    const senhaErrada = await tentarLogin({ login: 'a', password: 'errada' });
    assert.match(senhaErrada.log, /senha incorreta/);

    // Banco inalcancavel: 127.0.0.1:1 recusa a conexao imediatamente, entao o
    // teste nao depende de tempo de espera.
    process.env['DATABASE_URL'] = 'postgres://ninguem:nada@127.0.0.1:1/inexistente';
    const bancoFora = await tentarLogin({ login: 'a', password: SENHA });
    assert.match(bancoFora.log, /falha ao resolver concessoes/);

    // O identificador do log e o mesmo que o cliente recebeu: e o que permite
    // ligar "nao consigo entrar" a uma linha especifica.
    assert.ok(senhaErrada.requestId.length > 0);
    assert.ok(
      senhaErrada.log.includes(senhaErrada.requestId),
      'o log precisa citar o x-request-id devolvido',
    );

    // E o login digitado nunca entra no log (23.1): quem erra o campo e digita
    // a senha ali a entregaria ao registro.
    const comLoginSensivel = await tentarLogin({ login: SENHA, password: 'errada' });
    assert.ok(
      !comLoginSensivel.log.includes(SENHA),
      'o valor do campo de login nao pode aparecer no log',
    );
  });
});
