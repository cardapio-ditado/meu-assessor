/**
 * Aplicacao web do Meu Assessor.
 *
 * Regras do briefing que este arquivo respeita e que sao faceis de perder:
 *  - 7.4: estados obrigatorios de consulta; o usuario nunca fica preso em uma
 *    animacao sem prazo ou opcao de sair.
 *  - 6.4: as quatro camadas vem do MESMO envelope; a tela nao faz uma segunda
 *    consulta entre o resumo e o detalhe.
 *  - 7.1 / 7.3: ressalva de cobertura e idade da evidencia aparecem junto do
 *    fato, nao no rodape.
 *  - 19.1: se o navegador nao suportar gravacao, o texto continua disponivel;
 *    sem provedor de transcricao o produto DIZ isso em vez de simular.
 *  - Todo texto vindo do servidor entra por textContent. Nunca innerHTML.
 */

const el = (id) => document.getElementById(id);

const state = {
  me: null,
  lastEnvelope: null,
  abort: null,
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

function show(id) {
  for (const tela of document.querySelectorAll('.tela')) tela.hidden = tela.id !== id;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fill(listId, items, blockId) {
  const list = el(listId);
  clear(list);
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  el(blockId).hidden = items.length === 0;
}

const STATUS_LABEL = {
  complete: 'Documentado',
  partial: 'Resposta parcial',
  clarification_needed: 'Precisa de um esclarecimento',
  no_evidence: 'Sem evidencia localizada',
  unavailable: 'Servico indisponivel',
};

const ESTADO_LABEL = {
  documented: 'Documentado',
  source_reported: 'Informado pela fonte',
  partial: 'Parcial',
  divergent: 'Divergencia',
  not_located: 'Nao localizado',
  stale_for_question: 'Desatualizado para esta pergunta',
};

// ---------------------------------------------------------------------------
// Acesso
// ---------------------------------------------------------------------------

el('form-acesso').addEventListener('submit', async (event) => {
  event.preventDefault();
  const erro = el('erro-acesso');
  erro.hidden = true;
  const result = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ login: el('login').value.trim(), password: el('senha').value }),
  });
  if (!result.ok) {
    // 7.2: a mensagem nao revela se a conta existe.
    erro.textContent = result.body?.error ?? 'nao foi possivel entrar';
    erro.hidden = false;
    return;
  }
  await boot();
});

el('sair').addEventListener('click', async () => {
  await api('/v1/sessions', { method: 'DELETE' });
  state.me = null;
  el('sair').hidden = true;
  el('barra').hidden = true;
  el('municipio').textContent = '';
  show('tela-acesso');
});

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

async function boot() {
  const me = await api('/v1/me');
  if (!me.ok) {
    show('tela-acesso');
    return;
  }
  state.me = me.body;
  el('municipio').textContent = me.body.municipality;
  el('sair').hidden = false;
  el('barra').hidden = false;
  el('saudacao').textContent =
    `${me.body.municipality} - dados consultados no fuso ${me.body.timeZone}. Hoje: ${me.body.today}.`;
  el('rodape-aviso').textContent =
    'Ambiente de demonstracao. O conteudo carregado e ficticio e identificado como tal. ' +
    'Nenhum conector de fonte publica esta habilitado.';
  show('tela-inicio');
  await loadHome();
}

async function loadHome() {
  const home = await api('/v1/home');
  if (!home.ok) return;
  el('aviso-cobertura').textContent = home.body.coverageNotice;

  const cartoes = el('cartoes');
  clear(cartoes);
  if (home.body.cards.length === 0) {
    const p = document.createElement('p');
    p.className = 'ajuda';
    // 7.5: tela vazia nao e prova de inexistencia de acoes.
    p.textContent =
      `Nenhum fato registrado entre ${home.body.period.from} e ${home.body.period.to}. ` +
      'Isso descreve o recorte carregado, nao a ausencia de acoes na administracao.';
    cartoes.appendChild(p);
  }
  for (const card of home.body.cards) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cartao';

    const titulo = document.createElement('span');
    titulo.className = 'cartao-titulo';
    titulo.textContent = card.subjectName;
    button.appendChild(titulo);

    const meta = document.createElement('span');
    meta.className = 'cartao-meta';
    // 6.3: data do evento separada da data de publicacao.
    const partes = [
      card.area ?? 'sem area',
      `evento: ${card.factDate ?? 'data nao informada'}`,
      `publicacao: ${card.publicationDate ?? 'nao informada'}`,
      ESTADO_LABEL[card.state] ?? card.state,
    ];
    if (card.isSynthetic) partes.push('registro ficticio');
    meta.textContent = partes.join(' | ');
    button.appendChild(meta);

    button.addEventListener('click', () => {
      el('pergunta').value = `Como esta ${card.subjectName}?`;
      void submitQuestion();
    });
    cartoes.appendChild(button);
  }

  const cobertura = el('cobertura');
  clear(cobertura);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const h of ['Fonte', 'Conjunto', 'Integracao', 'Ultima coleta com exito']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const row of home.body.coverage) {
    const tr = document.createElement('tr');
    for (const value of [row.sourceCode, row.datasetName, row.integrationStatus]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    const td = document.createElement('td');
    td.textContent = row.lastSuccessAt ? row.lastSuccessAt.slice(0, 16) : 'nunca';
    if (row.stale) td.className = 'defasado';
    tr.appendChild(td);
    table.appendChild(tr);
  }
  cobertura.appendChild(table);
}

// ---------------------------------------------------------------------------
// Pergunta e resposta
// ---------------------------------------------------------------------------

el('form-pergunta').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitQuestion();
});

el('voltar').addEventListener('click', () => {
  if (state.abort !== null) state.abort.abort();
  show('tela-inicio');
});

async function submitQuestion(text) {
  const question = (text ?? el('pergunta').value).trim();
  if (question === '') return;

  show('tela-resposta');
  el('pergunta-eco').textContent = question;
  el('resposta').hidden = true;

  const estado = el('estado-consulta');
  estado.textContent = 'Consultando a base...';

  // 7.4 / 16.1: limite da interacao sincrona, com saida para o usuario.
  const controller = new AbortController();
  state.abort = controller;
  const limite = setTimeout(() => {
    estado.textContent =
      'A consulta esta demorando mais que o previsto. Voce pode esperar ou voltar e refazer a pergunta com um recorte menor.';
  }, 12_000);

  const result = await api('/v1/questions', {
    method: 'POST',
    body: JSON.stringify({ question, idempotencyKey: question }),
    signal: controller.signal,
  }).catch(() => ({ ok: false, status: 0, body: null }));

  clearTimeout(limite);
  state.abort = null;

  if (!result.ok) {
    // 16.5: indisponibilidade nao vira resposta inventada.
    estado.textContent =
      result.status === 401
        ? 'Sua sessao expirou. Entre novamente.'
        : 'Nao foi possivel consultar agora. A base nao foi alterada e nenhuma resposta foi gerada.';
    if (result.status === 401) show('tela-acesso');
    return;
  }

  estado.textContent = '';
  render(result.body);
}

function render(envelope) {
  state.lastEnvelope = envelope;
  el('resposta').hidden = false;

  el('selo-status').textContent = STATUS_LABEL[envelope.status] ?? envelope.status;
  el('selo-periodo').textContent =
    `Periodo: ${envelope.context.period}${envelope.plan?.periodIsDefault ? ' (padrao)' : ''}`;
  // 14.2 / 7.4: "Dados consultados ate..." nunca sugere fiscalizacao no momento
  // da leitura.
  el('selo-dados').textContent = envelope.sourceCheckedAt
    ? `Fontes verificadas ate ${String(envelope.sourceCheckedAt).slice(0, 16)}`
    : 'Nenhuma coleta automatica registrada';

  // Camada 1
  el('camada-breve').textContent = envelope.layers.brief;

  // Escolha de entidade (T02)
  const escolhas = el('escolhas');
  const lista = el('lista-escolhas');
  clear(lista);
  if (envelope.status === 'clarification_needed' && Array.isArray(envelope.candidates) && envelope.candidates.length > 1) {
    for (const candidate of envelope.candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secundario';
      // O tipo precisa aparecer: oferecer um contrato como alternativa a uma
      // obra sem dizer que e um contrato confunde (7.1).
      const detalhe = [candidate.locality, candidate.kindLabel].filter(Boolean).join(' - ');
      button.textContent = detalhe === '' ? candidate.name : `${candidate.name} (${detalhe})`;
      button.addEventListener('click', () => {
        void submitQuestion(candidate.name);
      });
      lista.appendChild(button);
    }
    escolhas.hidden = false;
  } else {
    escolhas.hidden = true;
  }

  // Camada 2
  const entenda = el('camada-entenda');
  clear(entenda);
  for (const fact of envelope.layers.understand) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = fact.label;
    const dd = document.createElement('dd');
    dd.textContent = fact.value;
    const meta = document.createElement('div');
    meta.className = 'fato-meta';
    meta.textContent = [
      ESTADO_LABEL[fact.state] ?? fact.state,
      `data do fato: ${fact.factDate ?? 'nao informada'}`,
      `${fact.evidenceIds.length} evidencia(s)`,
    ].join(' | ');
    dd.appendChild(meta);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    entenda.appendChild(wrap);
  }
  el('bloco-entenda').hidden = envelope.layers.understand.length === 0;

  fill('divergencias', envelope.conflicts ?? [], 'bloco-divergencias');
  fill('lacunas', envelope.missingFields ?? [], 'bloco-lacunas');
  fill('ressalvas', envelope.warnings ?? [], 'bloco-ressalvas');

  // Camada 3
  const historico = el('camada-historico');
  clear(historico);
  for (const item of envelope.layers.history) {
    const li = document.createElement('li');
    const datas = document.createElement('div');
    datas.className = 'datas';
    datas.textContent =
      `fato: ${item.factDate ?? 'nao informado'} | publicado: ${item.publicationDate ?? 'nao informado'} | ${item.relationNature}`;
    const titulo = document.createElement('div');
    titulo.textContent = item.title;
    li.appendChild(datas);
    li.appendChild(titulo);
    historico.appendChild(li);
  }
  el('bloco-historico').hidden = envelope.layers.history.length === 0;

  // Camada 4
  const comprove = el('camada-comprove');
  clear(comprove);
  el('bloco-comprove').hidden = envelope.layers.prove.length === 0;
  for (const id of envelope.layers.prove) {
    const box = document.createElement('div');
    box.className = 'evidencia';
    const carregando = document.createElement('p');
    carregando.className = 'ajuda';
    carregando.textContent = 'carregando trecho...';
    box.appendChild(carregando);
    comprove.appendChild(box);
    void loadEvidence(id, box);
  }

  // Verificacao
  const validador = envelope.validator;
  if (validador && validador.verdict !== 'passed') {
    el('bloco-validador').hidden = false;
    el('validador-texto').textContent =
      validador.verdict === 'reduced'
        ? `A resposta foi reduzida ao que as evidencias sustentam: ${validador.removed} afirmacao(oes) bloqueada(s) na verificacao.`
        : validador.verdict === 'abstained'
          ? 'A verificacao nao encontrou suporte suficiente e o sistema se absteve de responder.'
          : 'Todas as afirmacoes candidatas foram bloqueadas na verificacao. Nada foi afirmado.';
  } else {
    el('bloco-validador').hidden = true;
  }

  el('erro-enviado').textContent = '';
  el('nota-erro').value = '';
  window.scrollTo({ top: 0 });
}

async function loadEvidence(id, box) {
  const result = await api(`/v1/evidence/${encodeURIComponent(id)}`);
  clear(box);
  if (!result.ok) {
    const p = document.createElement('p');
    p.className = 'erro';
    // 7.8: link quebrado nao apaga o registro nem permite fingir acesso.
    p.textContent = 'Este trecho nao esta acessivel nesta sessao.';
    box.appendChild(p);
    return;
  }
  const { evidence, document: doc, hashNotice } = result.body;

  const titulo = document.createElement('div');
  titulo.style.fontWeight = '600';
  titulo.textContent = doc?.title_original ?? 'documento';
  box.appendChild(titulo);

  const quote = document.createElement('blockquote');
  quote.textContent = evidence.snippet;
  box.appendChild(quote);

  const meta = document.createElement('div');
  meta.className = 'fonte-meta';
  const partes = [
    `fonte ${doc?.source_code ?? '?'}`,
    evidence.locator,
    `publicado: ${doc?.publication_date ?? 'nao informado'}`,
    `coletado: ${doc?.collected_at?.slice(0, 16) ?? 'nao informado'}`,
    `versao ${doc?.record_version ?? '?'}`,
    `extracao: ${doc?.extraction_method ?? '?'}`,
  ];
  if (doc?.is_synthetic) partes.push('DOCUMENTO FICTICIO');
  meta.textContent = partes.join(' | ');
  box.appendChild(meta);

  const nota = document.createElement('div');
  nota.className = 'fonte-meta';
  nota.textContent = hashNotice;
  box.appendChild(nota);

  if (doc?.url_original) {
    const link = document.createElement('a');
    link.href = doc.url_original;
    link.rel = 'noreferrer noopener';
    link.target = '_blank';
    link.textContent = 'Abrir o original';
    box.appendChild(link);
  }
}

// ---------------------------------------------------------------------------
// "Ha um erro" (21.4)
// ---------------------------------------------------------------------------

el('form-erro').addEventListener('submit', async (event) => {
  event.preventDefault();
  const nota = el('nota-erro').value.trim();
  if (nota === '') return;
  const result = await api('/v1/feedback', {
    method: 'POST',
    body: JSON.stringify({ answerId: state.lastEnvelope?.answerId ?? null, note: nota }),
  });
  el('erro-enviado').textContent = result.ok
    ? result.body.notice
    : 'Nao foi possivel registrar o relato agora.';
  if (result.ok) el('nota-erro').value = '';
});

// ---------------------------------------------------------------------------
// Voz (19.1). Gravar, revisar, enviar. Texto sempre disponivel.
// ---------------------------------------------------------------------------

const MAX_SECONDS = 90;
let recorder = null;
let chunks = [];
let stopTimer = null;

const gravar = el('gravar');
const estadoVoz = el('estado-voz');

if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof window.MediaRecorder !== 'function') {
  // 19.1: se o dispositivo nao suporta, manter o texto como alternativa e
  // dizer isso, em vez de exibir um botao que nao funciona.
  gravar.disabled = true;
  gravar.hidden = true;
  estadoVoz.textContent = 'Este navegador nao permite gravacao. Use o campo de texto.';
}

gravar.addEventListener('click', async () => {
  if (recorder !== null) {
    stopRecording();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop();
      void sendAudio();
    });
    recorder.start();
    gravar.setAttribute('aria-pressed', 'true');
    gravar.querySelector('.rotulo-botao').textContent = 'Parar';
    estadoVoz.textContent = `Gravando. Toque em Parar quando terminar (limite de ${MAX_SECONDS}s).`;
    stopTimer = setTimeout(stopRecording, MAX_SECONDS * 1000);
  } catch {
    estadoVoz.textContent =
      'Permissao de microfone nao concedida. Voce pode digitar a pergunta no campo acima.';
  }
});

function stopRecording() {
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
  gravar.setAttribute('aria-pressed', 'false');
  gravar.querySelector('.rotulo-botao').textContent = 'Gravar';
}

async function sendAudio() {
  if (chunks.length === 0) {
    estadoVoz.textContent = 'Nao foi captado audio. Tente novamente ou digite a pergunta.';
    return;
  }
  estadoVoz.textContent = 'Enviando audio para transcricao...';
  const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
  const response = await fetch('/v1/transcriptions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type },
    body: blob,
  }).catch(() => null);

  if (response === null) {
    estadoVoz.textContent = 'Nao foi possivel enviar o audio agora. Use o campo de texto.';
    return;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // 28.2: nao simular sucesso. O produto diz que a transcricao nao existe
    // neste ambiente e mantem o caminho por texto.
    estadoVoz.textContent = body?.notice ?? 'Transcricao indisponivel. Use o campo de texto.';
    return;
  }
  // Quando houver provedor: preencher o campo e deixar o usuario REVISAR
  // antes de consultar (19.1), nunca consultar direto.
  el('pergunta').value = body.transcript ?? '';
  estadoVoz.textContent = 'Revise a transcricao no campo acima e toque em Perguntar.';
  el('pergunta').focus();
}

// ---------------------------------------------------------------------------
// Barra inferior
// ---------------------------------------------------------------------------

for (const button of document.querySelectorAll('.barra button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.barra button')) other.classList.remove('ativo');
    button.classList.add('ativo');
    if (button.dataset.tela === 'perguntar') {
      show('tela-inicio');
      el('pergunta').focus();
    } else {
      show(button.dataset.tela);
    }
  });
}

void boot();
