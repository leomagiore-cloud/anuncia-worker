require('dotenv').config();
const cron = require('node-cron');
const config = require('./src/config');
const logger = require('./src/logger');
const panelApi = require('./src/panelApi');
const imageHandler = require('./src/imageHandler');
const FacebookPoster = require('./src/poster');
let sessaoEmExecucao = false;
let conectandoFacebook = false;

function notificarAtividade(atividade = '') {
  const payload = { atividade };
  if (process.send) process.send({ type: 'state', ...payload });
  else process.stdout.write(`@@ANUNCIA_STATE ${JSON.stringify(payload)}\n`);
}

if (!process.env.PANEL_API_URL || !process.env.PANEL_WORKER_TOKEN || !process.env.WORKER_TENANT_ID) {
  throw new Error('Configure PANEL_API_URL, PANEL_WORKER_TOKEN e WORKER_TENANT_ID no arquivo .env deste computador.');
}
const tenantLocal = process.env.WORKER_TENANT_ID;

async function processarEmpresa(tenantId, incluirAgendados, targetPropertyId = null) {
  const inicio = Date.now();
  let poster = null;
  try {
    if (typeof logger.setTenantId === 'function') logger.setTenantId(tenantId);
    await panelApi.inicializar(tenantId);
    const contasAtivas = Object.keys(config.facebook.contas)
      .filter(id => config.facebook.contas[id].ativa)
      .map(Number);
    logger.info(`▶ Iniciando fila da empresa (${new Date().toLocaleString('pt-BR')})`);
    logger.info(`👥 ${contasAtivas.length} conta(s) ativa(s) carregada(s) do painel`);
    if (contasAtivas.length === 0) {
      logger.info('📭 Nenhuma conta ativa. Fila ignorada.');
      return { success: true };
    }

    const statuses = incluirAgendados || targetPropertyId ? ['pendente', 'agendado'] : ['pendente'];
    const pendentes = await panelApi.buscarPendentes(
      tenantId,
      targetPropertyId ? 1 : config.postagem.maxPorSessao,
      contasAtivas,
      statuses,
      targetPropertyId
    );
    if (pendentes.length === 0) {
      logger.info('📭 Nenhum imóvel pendente. Fila encerrada.');
      return { success: true };
    }

    logger.info(`📋 ${pendentes.length} imóvel(is) pendente(s) encontrado(s)`);
    poster = new FacebookPoster();

    let postados = 0;
    let erros = 0;
    for (let i = 0; i < pendentes.length; i++) {
      const imovel = pendentes[i];
      if (typeof logger.setPropertyId === 'function') logger.setPropertyId(imovel.id);
      logger.info(`\n[${i + 1}/${pendentes.length}] Processando: ${imovel.titulo}`);
      const imagensLocais = await imageHandler.processarImagens(imovel.imagens);

      if (imagensLocais.length === 0) {
        const motivo = imovel.imagens ? 'Sem imagens disponíveis (URLs expiradas)' : 'Imóvel sem imagens';
        logger.warn(`⚠️ ${motivo}: ${imovel.titulo}`);
        await panelApi.marcarErro(tenantId, imovel._linhaIdx, motivo);
        erros++;
        continue;
      }

      const resultado = await poster.postarMultiplasContas(
        imovel,
        imagensLocais,
        imovel.contasPendentes || contasAtivas,
        {
          persistirResultados: false,
          publicarEmGrupos: true,
          onAccountResult: (accountResult) =>
            panelApi.registrarResultados(tenantId, imovel._linhaIdx, [accountResult]),
        }
      );
      await panelApi.finalizarImovel(tenantId, imovel._linhaIdx);

      if (resultado.sucesso || resultado.resultados?.some(result => result.sucesso)) {
        postados++;
      } else {
        erros++;
        await panelApi.marcarErro(
          tenantId,
          imovel._linhaIdx,
          resultado.resultados?.[0]?.erro || 'Falha em todas as contas'
        );
      }

      if (i < pendentes.length - 1) {
        const delayMs = config.postagem.delayEntrePostsMs + Math.random() * 30000;
        logger.info(`⏳ Aguardando ${Math.round(delayMs / 1000)}s antes do próximo...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      if (typeof logger.setPropertyId === 'function') logger.setPropertyId(null);
    }

    const duracao = Math.round((Date.now() - inicio) / 1000);
    logger.info(`✅ SESSÃO CONCLUÍDA em ${duracao}s — Postados: ${postados} | Erros: ${erros}`);
    return {
      success: erros === 0,
      error: erros ? `${erros} imóvel(is) não foram publicados. Confira os erros no painel.` : undefined,
    };
  } catch (err) {
    logger.error(`ERRO NA FILA DA EMPRESA: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    try {
      await imageHandler.limparTempForcado();
    } finally {
      try {
        if (poster) await poster.fechar();
      } finally {
        panelApi.limparCredenciais();
        if (typeof logger.setPropertyId === 'function') logger.setPropertyId(null);
        if (typeof logger.setAccountNumber === 'function') logger.setAccountNumber(null);
        if (typeof logger.setTenantId === 'function') logger.setTenantId(null);
      }
    }
  }
}

async function executarSessao({ incluirAgendados = true, tenantId, targetPropertyId = null } = {}) {
  if (sessaoEmExecucao) {
    logger.warn('⏭️ Uma sessão já está em execução; ignorando esta chamada.');
    return { success: false, error: 'Já existe uma sessão em execução.' };
  }
  sessaoEmExecucao = true;
  notificarAtividade('Publicando anúncios');
  try {
    const tenantIds = [tenantId || tenantLocal];
    if (tenantIds.length === 0) {
      logger.info('📭 Nenhuma empresa com contas ativas no painel.');
      return { success: true };
    }

    logger.info(`▶ Iniciando sessão local para a empresa vinculada.`);
    const results = [];
    for (const id of tenantIds) {
      try {
        results.push(await processarEmpresa(id, incluirAgendados, targetPropertyId));
      } catch (err) {
        if (typeof logger.setTenantId === 'function') logger.setTenantId(id);
        logger.error(`ERRO AO ENCERRAR A FILA DA EMPRESA: ${err.message}`);
        if (typeof logger.setTenantId === 'function') logger.setTenantId(null);
        results.push({ success: false, error: err.message });
      }
    }
    const failures = results.filter(result => !result.success);
    return {
      success: failures.length === 0,
      error: failures.length
        ? `${failures.length} empresa(s) tiveram falha. Confira os erros no painel.`
        : undefined,
    };
  } catch (err) {
    logger.error('ERRO CRÍTICO NA SESSÃO: ' + err.message);
    return { success: false, error: err.message };
  } finally {
    sessaoEmExecucao = false;
    notificarAtividade('');
  }
}


async function conectarContasFacebook() {
  if (sessaoEmExecucao || conectandoFacebook) {
    logger.warn('Já existe uma atividade em andamento no Worker.');
    return;
  }
  conectandoFacebook = true;
  sessaoEmExecucao = true;
  notificarAtividade('Aguardando login do Facebook');
  const headlessOriginal = config.puppeteer.headless;
  const userDataDirOriginal = config.puppeteer.userDataDir;
  try {
    await panelApi.inicializar(tenantLocal);
    const contas = Object.entries(config.facebook.contas).filter(([, conta]) => conta.ativa && conta.email);
    if (!contas.length) throw new Error('Não há contas ativas. Cadastre e ative uma conta nas Configurações do painel.');
    for (const [numero, conta] of contas) {
      config.puppeteer.headless = false;
      config.puppeteer.userDataDir = conta.userDataDir;
      notificarAtividade(`Conectando Facebook — conta ${numero}`);
      const poster = new FacebookPoster();
      try {
        await poster.iniciar();
        await poster.page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 40000 });
        logger.info(`🔐 Conta ${numero}: faça login e conclua as confirmações na janela do Facebook.`);
        await poster._aguardarLoginManual(10 * 60 * 1000);
        logger.info(`✅ Conta ${numero}: sessão salva neste computador.`);
      } finally {
        await poster.fechar().catch(() => {});
      }
    }
    logger.info('✅ Todas as contas ativas foram conectadas. As próximas publicações usarão o modo invisível quando a sessão estiver válida.');
  } catch (error) {
    logger.error(`Falha ao conectar Facebook: ${error.message}`);
  } finally {
    config.puppeteer.headless = headlessOriginal;
    config.puppeteer.userDataDir = userDataDirOriginal;
    panelApi.limparCredenciais();
    conectandoFacebook = false;
    sessaoEmExecucao = false;
    notificarAtividade('');
  }
}

const executarPostagemManual = () => executarSessao({ tenantId: tenantLocal })
  .catch((err) => logger.error(`Falha na postagem manual: ${err.message}`));
global.__anunciaPostNow = executarPostagemManual;
global.__anunciaConnectFacebook = conectarContasFacebook;
if (process.send) {
  process.on('message', (message) => {
    if (message?.type === 'post-now') {
      logger.info('[IPC] Comando recebido: post-now');
      executarPostagemManual();
    }
    if (message?.type === 'connect-facebook') {
      logger.info('[IPC] Comando recebido: connect-facebook');
      conectarContasFacebook();
    }
  });
}

// Valida a conexão e carrega as contas ativas ao iniciar. O log antigo de
// "conectado" era apenas informativo e não confirmava a resposta da API.
(async () => {
  try {
    await panelApi.inicializar(tenantLocal);
    const total = Object.values(config.facebook.contas).filter((conta) => conta.ativa && conta.email).length;
    logger.info(`✅ Conexão com o painel validada: ${total} conta(s) ativa(s) recebida(s).`);
  } catch (error) {
    logger.error(`❌ Não foi possível carregar as contas do painel: ${error.message}`);
  } finally {
    panelApi.limparCredenciais();
  }
})();

// ──────────────────────────────────────────────────────────────
// MODO --now
// ──────────────────────────────────────────────────────────────
if (process.argv.includes('--now')) {
  logger.info('⚡ Modo manual (--now): executando agora...');
  executarSessao().catch(err => {
    logger.error('Erro fatal: ' + err.message);
    process.exit(1);
  });
} else {
  logger.info('⏰ Scheduler iniciado. Aguardando horários configurados...');
  logger.info('🔗 Worker local conectado ao painel AnuncIA.');
  logger.info(`  Horário 1: ${config.postagem.cron.horario1}`);
  logger.info(`  Horário 2: ${config.postagem.cron.horario2}`);
  logger.info(`  Horário 3: ${config.postagem.cron.horario3}`);

  const horarios = [
    config.postagem.cron.horario1,
    config.postagem.cron.horario2,
    config.postagem.cron.horario3,
  ];

  horarios.forEach((horario, idx) => {
    if (!cron.validate(horario)) {
      logger.error(`❌ CRON inválido para Horário ${idx + 1}: "${horario}"`);
      return;
    }

    cron.schedule(horario, () => {
      logger.info(`🔔 Cron disparou (Horário ${idx + 1}): ${horario}`);
      executarSessao().catch(err => logger.error('Erro no cron: ' + err.message));
    }, {
      timezone: 'America/Sao_Paulo',
    });
  });

  const consultarFilaDeComandos = async () => {
    if (sessaoEmExecucao) return;
    try {
      const command = await panelApi.buscarComando(tenantLocal);
      if (!command) return;

      const tenantId = command.tenantId;
      if (typeof logger.setTenantId === 'function') logger.setTenantId(tenantId);
      logger.info(`⚡ Pedido manual de postagem recebido: ${command.id}`);
      const resultado = await executarSessao({
        incluirAgendados: false,
        tenantId,
        targetPropertyId: command.propertyId || null,
      });
      await panelApi.finalizarComando(
        tenantId,
        command.id,
        resultado?.success === true,
        resultado?.error
      );
    } catch (err) {
      logger.error(`Falha ao processar pedido manual: ${err.message}`);
    }
  };

  logger.info('🔄 Consultando pedidos de postagem do painel a cada 15 segundos.');
  consultarFilaDeComandos();
  setInterval(consultarFilaDeComandos, 15000);

  logger.info('\n💡 Para postar agora: npm run post-agora');
  logger.info('\n');
}