/**
 * Catalogo de fontes do piloto (8.2, 8.3, Anexo H).
 *
 * Regra do briefing que este arquivo respeita literalmente (C.2):
 * "Diferencie pagina localizada de conector testado. [...] Nao crie um endpoint
 * por adivinhacao."
 *
 * Por isso cada fonte carrega `integrationStatus` e `probe`:
 *  - page_located: endereco conhecido pela referencia do briefing
 *  - access_probed: houve tentativa de acesso registrada, com resultado
 *  - connector_built / connector_verified: existe codigo e amostra reproduzida
 *  - blocked: acesso rejeitado ou indisponivel
 *
 * Nenhuma fonte nasce `enabled`. Ativar um conector e decisao de operacao
 * autorizada, nao efeito de importar este modulo.
 */

export type IntegrationStatus =
  | 'page_located'
  | 'access_probed'
  | 'connector_built'
  | 'connector_verified'
  | 'blocked';

export interface DatasetSpec {
  readonly name: string;
  readonly recordType: string;
  readonly cadence: string;
  readonly staleAfterHours: number;
}

export interface SourceSpec {
  readonly code: string;
  readonly officialName: string;
  /** Endereco de referencia citado no Anexo H do briefing. */
  readonly url: string;
  /**
   * Endereco a usar na prova de acesso, quando difere do de referencia. A
   * pagina de documentacao de uma API pode morar em outro dominio que nao o do
   * endpoint: sondar o dominio errado produziria um resultado sem valor.
   */
  readonly probeUrl?: string;
  readonly domain: string;
  readonly organ: string;
  readonly sphere: 'municipal' | 'state' | 'federal' | 'association' | 'other';
  readonly role: string;
  readonly recordTypes: readonly string[];
  readonly accessMethod: 'api' | 'structured_export' | 'html' | 'document' | 'manual';
  readonly requiresCredentials: boolean;
  readonly integrationStatus: IntegrationStatus;
  /** Resultado da tentativa de acesso desta sessao, textual e datado. */
  readonly probe: string;
  readonly knownLimitations: readonly string[];
  readonly datasets: readonly DatasetSpec[];
}

const DAILY = { cadence: 'duas janelas diarias', staleAfterHours: 36 } as const;
const WEEKLY = { cadence: 'semanal', staleAfterHours: 24 * 10 } as const;

/**
 * Resultado da prova de acesso executada em 2026-09-12 no ambiente de
 * desenvolvimento deste repositorio. Ver docs/sources/prova-de-acesso.md.
 * Todos os hosts abaixo retornaram 403 no CONNECT do proxy de egresso do
 * ambiente: o bloqueio e do ambiente, nao dos portais.
 */
/**
 * Resultado da sondagem de 2026-09-13, rodada pelo workflow "Prova de acesso as
 * fontes (E1)" (execucao 34757007445) num runner com saida de rede publica. Os
 * controles neutros responderam 200 na mesma execucao, entao o desfecho e
 * atribuivel a fonte e nao ao ambiente.
 *
 * A tentativa anterior, de 2026-09-12, media outra coisa: o ambiente de
 * execucao negava CONNECT para qualquer host fora de uma allowlist estreita, e
 * `example.com` falhava igual aos portais. Fica registrada porque distingue
 * "nao sabemos" de "o portal nao responde" — e porque foi o que motivou os
 * controles neutros na sondagem.
 */
const REACHED = 'sondagem em 2026-09-13 (E1): respondeu 200; alcance comprovado, conector NAO verificado';

export const SOURCE_CATALOG: readonly SourceSpec[] = [
  {
    code: 'F01',
    officialName: 'Prefeitura Municipal de Varzea Grande',
    url: 'https://www.varzeagrande.mt.gov.br/',
    domain: 'www.varzeagrande.mt.gov.br',
    organ: 'Prefeitura Municipal de Varzea Grande',
    sphere: 'municipal',
    role: 'Noticias, estrutura e caminhos para servicos',
    recordTypes: ['news', 'organization_chart'],
    accessMethod: 'html',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: [
      'cobertura historica do arquivo de noticias nao medida',
      'noticia oficial nao substitui registro administrativo (8.1)',
    ],
    datasets: [{ name: 'noticias', recordType: 'news', ...DAILY }],
  },
  {
    code: 'F02',
    officialName: 'Portal da Transparencia de Varzea Grande',
    url: 'https://www.varzeagrande.mt.gov.br/transparencia',
    domain: 'www.varzeagrande.mt.gov.br',
    organ: 'Prefeitura Municipal de Varzea Grande',
    sphere: 'municipal',
    role: 'Despesas, receitas, contratos, convenios e atalhos',
    recordTypes: ['expense', 'revenue', 'contract', 'agreement'],
    accessMethod: 'html',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: [
      'e um indice: cada destino exige teste individual',
      'CNPJ 03.507.548/0001-10 e o ente principal, nao a familia completa de fundos e autarquias (8.2)',
    ],
    datasets: [
      { name: 'contratos', recordType: 'contract', ...DAILY },
      { name: 'despesas', recordType: 'expense', ...DAILY },
    ],
  },
  {
    code: 'F03',
    officialName: 'Portal municipal de emendas parlamentares',
    url: 'https://emendas.varzeagrande.mt.gov.br/portal',
    domain: 'emendas.varzeagrande.mt.gov.br',
    organ: 'Prefeitura Municipal de Varzea Grande',
    sphere: 'municipal',
    role: 'Relacoes e registros de emendas',
    recordTypes: ['amendment'],
    accessMethod: 'html',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: ['escopo, paginacao e acesso estruturado nao validados'],
    datasets: [{ name: 'emendas', recordType: 'amendment', ...DAILY }],
  },
  {
    code: 'F04',
    officialName: 'Diario Oficial de Varzea Grande',
    url: 'https://diariooficial.varzeagrande.mt.gov.br/',
    domain: 'diariooficial.varzeagrande.mt.gov.br',
    organ: 'Prefeitura Municipal de Varzea Grande',
    sphere: 'municipal',
    role: 'Atos, contratos, aditivos e publicacoes',
    recordTypes: ['official_act', 'contract', 'amendment_act'],
    accessMethod: 'document',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: [
      'arquivo historico e qualidade dos documentos nao medidos',
      'edicoes antigas podem exigir OCR, que e ultimo recurso (13.2)',
    ],
    datasets: [{ name: 'edicoes', recordType: 'official_act', ...DAILY }],
  },
  {
    code: 'F05',
    officialName: 'Jornal Oficial AMM-MT',
    url: 'https://amm.diariomunicipal.org/',
    domain: 'amm.diariomunicipal.org',
    organ: 'Associacao Mato-grossense dos Municipios',
    sphere: 'association',
    role: 'Publicacoes municipais e historico complementar',
    recordTypes: ['official_act'],
    accessMethod: 'document',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: ['nao presumir que substitui todo o diario proprio do municipio (8.2)'],
    datasets: [{ name: 'publicacoes-vg', recordType: 'official_act', ...DAILY }],
  },
  {
    code: 'F06',
    officialName: 'PNCP - Portal Nacional de Contratacoes Publicas',
    url: 'https://www.gov.br/pncp/pt-br/acesso-a-informacao/dados-abertos',
    probeUrl: 'https://pncp.gov.br/api/consulta/swagger-ui/index.html',
    domain: 'pncp.gov.br',
    organ: 'Governo Federal',
    sphere: 'federal',
    role: 'Contratacoes e documentos publicados',
    recordTypes: ['procurement', 'contract'],
    accessMethod: 'api',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: [
      'recorte e historico a verificar; endpoints devem sair da documentacao oficial, nao de suposicao',
    ],
    datasets: [{ name: 'contratos', recordType: 'contract', ...DAILY }],
  },
  {
    code: 'F07',
    officialName: 'Portal da Transparencia - API de dados (CGU)',
    url: 'https://portaldatransparencia.gov.br/api-de-dados',
    probeUrl: 'https://api.portaldatransparencia.gov.br/swagger-ui/index.html',
    domain: 'api.portaldatransparencia.gov.br',
    organ: 'Controladoria-Geral da Uniao',
    sphere: 'federal',
    role: 'Emendas e execucao federal',
    recordTypes: ['amendment', 'financial_event'],
    accessMethod: 'api',
    requiresCredentials: true,
    integrationStatus: 'access_probed',
    probe: `${REACHED}; a pagina de documentacao respondeu, mas a API exige cadastro e token, entao o acesso aos DADOS continua nao demonstrado (F07)`,
    knownLimitations: ['uso da API exige cadastro e token', 'limites de requisicao a confirmar'],
    datasets: [{ name: 'emendas', recordType: 'amendment', ...DAILY }],
  },
  {
    code: 'F10',
    officialName: 'Transferegov.br - APIs de dados abertos',
    url: 'https://api-publica.transferegov.gestao.gov.br/',
    domain: 'api-publica.transferegov.gestao.gov.br',
    organ: 'Ministerio da Gestao e da Inovacao em Servicos Publicos',
    sphere: 'federal',
    role: 'Instrumentos, transferencias e relacoes de recursos',
    recordTypes: ['transfer_instrument', 'financial_event'],
    accessMethod: 'api',
    requiresCredentials: false,
    integrationStatus: 'access_probed',
    probe: REACHED,
    knownLimitations: ['modulos, filtros e modelos a validar'],
    datasets: [{ name: 'instrumentos', recordType: 'transfer_instrument', ...WEEKLY }],
  },
  {
    code: 'F24',
    officialName: 'Geo-obras Cidadao / TCE-MT',
    url: 'https://geoobras.tce.mt.gov.br/',
    domain: 'geoobras.tce.mt.gov.br',
    organ: 'Tribunal de Contas do Estado de Mato Grosso',
    sphere: 'state',
    role: 'Evidencias e registros sobre obras',
    recordTypes: ['public_work'],
    accessMethod: 'html',
    requiresCredentials: false,
    // O briefing registra que o acesso consultado foi REJEITADO na preparacao.
    // Esse bloqueio permanece especifico e nao pode ser descrito como
    // integracao concluida (24.2).
    integrationStatus: 'blocked',
    probe:
      'briefing F24: tentativa de acesso ao caminho indicado pela prefeitura retornou rejeicao; ' +
      'sondagem em 2026-09-13 (E1): nao respondeu em 25 s, enquanto as outras oito fontes e os ' +
      'controles neutros responderam 200 na mesma execucao. Uma falha isolada nao separa ' +
      'indisponibilidade momentanea de bloqueio por origem; somada a rejeicao ja registrada no ' +
      'briefing, mantem-se `blocked`. Nenhuma API, exportacao ou coleta automatizada confirmada.',
    knownLimitations: ['sem API, exportacao ou coleta automatizada confirmada'],
    datasets: [{ name: 'obras', recordType: 'public_work', ...WEEKLY }],
  },
];

export function findSource(code: string): SourceSpec | undefined {
  return SOURCE_CATALOG.find((s) => s.code === code);
}

/** Hosts das fontes do catalogo, para montar INGESTION_ALLOWED_HOSTS. */
export function catalogHosts(): string[] {
  return [...new Set(SOURCE_CATALOG.map((s) => s.domain))];
}
