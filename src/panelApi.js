const config = require('./config');
const logger = require('./logger');
const path = require('path');

function getApiSettings() {
  const baseUrl = process.env.PANEL_API_URL?.replace(/\/+$/, '');
  const token = process.env.PANEL_WORKER_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('PANEL_API_URL e PANEL_WORKER_TOKEN precisam estar configurados para usar o painel');
  }
  const parsedUrl = new URL(baseUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);
  if (!isLocal && parsedUrl.protocol !== 'https:') {
    throw new Error('PANEL_API_URL deve usar HTTPS em produção');
  }
  return { baseUrl, token };
}

async function request(path, options = {}) {
  const { baseUrl, token } = getApiSettings();
  const response = await fetch(`${baseUrl}/api/worker/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Painel respondeu HTTP ${response.status}`);
  }
  return body;
}

async function listarTenants() {
  const { tenantIds } = await request('tenants');
  if (!Array.isArray(tenantIds)) {
    throw new Error('O painel retornou uma lista de empresas inválida');
  }
  return tenantIds;
}

function limparCredenciais() {
  config.facebook.email = '';
  config.facebook.whatsapp = '';
  config.facebook.creci = '';
  for (const conta of Object.values(config.facebook.contas)) {
    conta.email = '';
    conta.ativa = false;
    conta.whatsapp = '';
    conta.creci = '';
    conta.userDataDir = '';
  }
}

async function inicializar(tenantId) {
  if (!tenantId) throw new Error('É necessário informar a empresa para carregar as contas');
  limparCredenciais();
  const query = new URLSearchParams({ tenantId });
  const { accounts } = await request(`credentials?${query}`);
  if (!Array.isArray(accounts)) {
    throw new Error('O painel retornou uma lista de contas inválida');
  }

  for (const account of accounts) {
    const numero = Number(account.numero);
    const conta = config.facebook.contas[numero];
    if (!conta) continue;
    if (!account.login) {
      throw new Error(`A conta ${numero} da empresa não tem e-mail ou telefone cadastrado`);
    }
    conta.nome = account.nome;
    conta.email = account.login;
    conta.whatsapp = account.whatsapp || '';
    conta.creci = account.creci || '';
    conta.userDataDir = path.resolve(process.env.WORKER_DATA_DIR || process.cwd(), 'chrome-profiles', tenantId, `conta${numero}`);
    conta.ativa = true;
  }

  const contasAtivas = Object.values(config.facebook.contas).filter((conta) => conta.ativa && conta.email);
  if (!contasAtivas.length) {
    throw new Error('Nenhuma conta ativa foi recebida do painel');
  }
  logger.info(`✅ Painel conectado; ${contasAtivas.length} conta(s) ativa(s) carregada(s)`);
}

async function buscarPendentes(tenantId, limite = 5, contasIds = [], status = ['pendente', 'agendado'], propertyId = null) {
  const contas = Array.isArray(contasIds) ? contasIds : [contasIds];
  const query = new URLSearchParams({
    tenantId,
    limit: String(propertyId ? 1 : limite),
    accounts: contas.join(','),
    status: status.join(','),
  });
  if (propertyId) query.set('propertyId', propertyId);
  const { jobs } = await request(`jobs?${query}`);
  logger.info(`📋 ${jobs.length} imóvel(is) pendente(s) recebido(s) do painel`);
  return jobs;
}

async function marcarErro(tenantId, imovelId, erro) {
  await request('results', {
    method: 'POST',
    body: JSON.stringify({
      tenantId,
      propertyErrors: [{ imovelId, erro: String(erro).slice(0, 2000) }],
    }),
  });
}

async function registrarResultados(tenantId, imovelId, resultados = []) {
  const events = resultados.map((resultado) => ({
    imovelId,
    numero: Number(resultado.contaId),
    status: resultado.sucesso ? 'postado' : 'erro',
    link: resultado.link,
    erro: resultado.erro,
  }));
  if (!events.length) return;

  await request('results', {
    method: 'POST',
    body: JSON.stringify({ tenantId, events }),
  });
}

async function finalizarImovel(tenantId, imovelId) {
  await request('results', {
    method: 'POST',
    body: JSON.stringify({ tenantId, completedPropertyIds: [imovelId] }),
  });
}

async function buscarComando(tenantId) {
  const query = new URLSearchParams({ tenantId });
  const { command } = await request(`commands?${query}`);
  return command;
}

async function finalizarComando(tenantId, id, sucesso, erro = '') {
  await request('commands', {
    method: 'POST',
    body: JSON.stringify({
      tenantId,
      id,
      status: sucesso ? 'concluido' : 'erro',
      error: sucesso ? undefined : String(erro).slice(0, 2000),
    }),
  });
}

module.exports = {
  inicializar,
  limparCredenciais,
  buscarPendentes,
  marcarErro,
  registrarResultados,
  finalizarImovel,
  buscarComando,
  finalizarComando,
};
