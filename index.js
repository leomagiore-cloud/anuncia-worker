
'use strict';

const cron = require('node-cron');
const config = require('./src/config');
const logger = require('./src/logger');
const panelApi = require('./src/panelApi');
const session = require('./src/session');
const imageHandler = require('./src/imageHandler');
const FacebookPoster = require('./src/poster');

let sessaoEmExecucao = false;
let conectandoFacebook = false;
let tenantValidado = null;
let validacaoEmAndamento = null;
let consultandoFila = false;
let workerEncerrando = false;

const fbSession = require('./src/fbSession');

// Avisa o aplicativo quando o painel pausa ou libera o Worker.
session.events.on('blocked', (info) => {
  if (typeof process.send === 'function') process.send({ type: 'worker-blocked', info }, () => {});
});

// Contas ativas conhecidas (preenchido ao carregar as credenciais do painel).
let contasConhecidas = [];

function lerContasAtivas() {
  return Object.entries(config.facebook.contas)
    .filter(([, conta]) => conta.ativa && conta.email)
    .map(([numero, conta]) => ({
      numero: Number(numero),
      nome: conta.nome || `Conta ${numero}`,
      dir: conta.userDataDir,
    }));
}

function emitirStatusFacebook() {
  if (typeof process.send !== 'function') return;
  process.send({
    type: 'fb-status',
    contas: contasConhecidas.map((conta) => ({
      numero: conta.numero,
      nome: conta.nome,
      conectada: fbSession.estaConectada(conta.dir),
    })),
  }, () => {});
}

function notificarAtividade(atividade = '') {
  const payload = { atividade };

  if (typeof process.send === 'function') {
    process.send({ type: 'state', ...payload }, () => {});
  } else {
    process.stdout.write(
      `@@ANUNCIA_STATE ${JSON.stringify(payload)}\n`
    );
  }
}

function tenantAtualValido(tenantId) {
  return Boolean(
    session.isAuthenticated() &&
    tenantId &&
    session.tenantId === tenantId
  );
}

function exigirSessao() {
  if (!session.isAuthenticated()) {
    throw new Error(
      'Nenhum usuário conectado. Entre com sua conta AnuncIA no aplicativo.'
    );
  }

  if (session.blocked) {
    throw new Error(`Worker pausado: ${session.blocked.message}`);
  }

  return session.tenantId;
}

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (typeof process.send !== 'function') {
  throw new Error(
    'O Worker deve ser iniciado pelo aplicativo AnuncIA Worker.'
  );
}

// ──────────────────────────────────────────────────────────────
// Processamento da fila de imóveis
// ──────────────────────────────────────────────────────────────

async function processarEmpresa(
  tenantId,
  incluirAgendados,
  targetPropertyId = null
) {
  const inicio = Date.now();
  let poster = null;

  try {
    if (!tenantAtualValido(tenantId)) {
      throw new Error(
        'Sessão inválida ou encerrada antes do processamento.'
      );
    }

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(tenantId);
    }

    await panelApi.inicializar(tenantId);

    if (!tenantAtualValido(tenantId)) {
      throw new Error(
        'A sessão foi alterada durante a inicialização da empresa.'
      );
    }

    const contasAtivas = Object.keys(config.facebook.contas)
      .filter((id) => config.facebook.contas[id].ativa)
      .map(Number);

    logger.info(
      `▶ Iniciando fila da empresa (${new Date().toLocaleString('pt-BR')})`
    );

    logger.info(
      `👥 ${contasAtivas.length} conta(s) ativa(s) carregada(s) do painel`
    );

    if (contasAtivas.length === 0) {
      logger.info('📭 Nenhuma conta ativa. Fila ignorada.');
      return { success: true };
    }

    const statuses =
      incluirAgendados || targetPropertyId
        ? ['pendente', 'agendado']
        : ['pendente'];

    const pendentes = await panelApi.buscarPendentes(
      tenantId,
      targetPropertyId ? 1 : config.postagem.maxPorSessao,
      contasAtivas,
      statuses,
      targetPropertyId
    );

    if (!tenantAtualValido(tenantId)) {
      throw new Error(
        'A sessão foi encerrada durante a consulta dos imóveis.'
      );
    }

    if (!pendentes.length) {
      logger.info('📭 Nenhum imóvel pendente. Fila encerrada.');
      return { success: true };
    }

    logger.info(
      `📋 ${pendentes.length} imóvel(is) pendente(s) encontrado(s)`
    );

    poster = new FacebookPoster();

    let postados = 0;
    let erros = 0;

    for (let i = 0; i < pendentes.length; i++) {
      if (!tenantAtualValido(tenantId)) {
        throw new Error(
          'Sessão encerrada. Processamento interrompido por segurança.'
        );
      }

      const imovel = pendentes[i];

      if (typeof logger.setPropertyId === 'function') {
        logger.setPropertyId(imovel.id);
      }

      logger.info(
        `\n[${i + 1}/${pendentes.length}] Processando: ${imovel.titulo}`
      );

      let imagensLocais = [];

      try {
        imagensLocais = await imageHandler.processarImagens(
          imovel.imagens
        );
      } catch (error) {
        logger.error(
          `Falha ao baixar imagens do imóvel ${imovel.titulo}: ${error.message}`
        );
      }

      if (!imagensLocais.length) {
        const motivo = imovel.imagens
          ? 'Sem imagens disponíveis (URLs expiradas)'
          : 'Imóvel sem imagens';

        logger.warn(`⚠️ ${motivo}: ${imovel.titulo}`);

        await panelApi.marcarErro(
          tenantId,
          imovel._linhaIdx,
          motivo
        );

        erros++;

        if (typeof logger.setPropertyId === 'function') {
          logger.setPropertyId(null);
        }

        continue;
      }

      if (!tenantAtualValido(tenantId)) {
        throw new Error(
          'Sessão encerrada antes da publicação.'
        );
      }

      let resultado;

      try {
        resultado = await poster.postarMultiplasContas(
          imovel,
          imagensLocais,
          imovel.contasPendentes || contasAtivas,
          {
            persistirResultados: false,
            publicarEmGrupos: true,

            onAccountResult: (accountResult) =>
              panelApi.registrarResultados(
                tenantId,
                imovel._linhaIdx,
                [accountResult]
              ),
          }
        );
      } catch (error) {
        resultado = {
          sucesso: false,
          resultados: [
            {
              sucesso: false,
              erro: error.message,
            },
          ],
        };

        logger.error(
          `Erro ao publicar ${imovel.titulo}: ${error.message}`
        );
      }

      await panelApi.finalizarImovel(
        tenantId,
        imovel._linhaIdx
      );

      const teveSucesso =
        resultado?.sucesso ||
        resultado?.resultados?.some(
          (item) => item.sucesso
        );

      if (teveSucesso) {
        postados++;
      } else {
        erros++;

        const motivo =
          resultado?.resultados?.find(
            (item) => item.erro
          )?.erro || 'Falha em todas as contas';

        await panelApi.marcarErro(
          tenantId,
          imovel._linhaIdx,
          motivo
        );
      }

      if (typeof logger.setPropertyId === 'function') {
        logger.setPropertyId(null);
      }

      if (i < pendentes.length - 1) {
        const delayMs =
          config.postagem.delayEntrePostsMs +
          Math.random() * 30000;

        logger.info(
          `⏳ Aguardando ${Math.round(delayMs / 1000)}s antes do próximo...`
        );

        await aguardar(delayMs);
      }
    }

    const duracao = Math.round(
      (Date.now() - inicio) / 1000
    );

    logger.info(
      `✅ SESSÃO CONCLUÍDA em ${duracao}s — Postados: ${postados} | Erros: ${erros}`
    );

    return {
      success: erros === 0,
      error: erros
        ? `${erros} imóvel(is) não foram publicados. Confira os erros no painel.`
        : undefined,
    };
  } catch (err) {
    logger.error(
      `ERRO NA FILA DA EMPRESA: ${err.message}`
    );

    return {
      success: false,
      error: err.message,
    };
  } finally {
    try {
      await imageHandler.limparTempForcado();
    } catch (error) {
      logger.warn(
        `Falha ao limpar imagens temporárias: ${error.message}`
      );
    }

    try {
      if (poster) {
        await poster.fechar();
      }
    } catch (error) {
      logger.warn(
        `Falha ao fechar o navegador: ${error.message}`
      );
    }

    try {
      panelApi.limparCredenciais();
    } catch (error) {
      logger.warn(
        `Falha ao limpar credenciais do painel: ${error.message}`
      );
    }

    if (typeof logger.setPropertyId === 'function') {
      logger.setPropertyId(null);
    }

    if (typeof logger.setAccountNumber === 'function') {
      logger.setAccountNumber(null);
    }

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(null);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Execução de sessão
// ──────────────────────────────────────────────────────────────

async function executarSessao({
  incluirAgendados = true,
  tenantId,
  targetPropertyId = null,
} = {}) {
  if (session.blocked) {
    logger.warn(`⏸️ Worker pausado: ${session.blocked.message}`);
    return { success: false, error: session.blocked.message };
  }

  if (sessaoEmExecucao || conectandoFacebook) {
    logger.warn(
      '⏭️ Uma atividade já está em execução; ignorando esta chamada.'
    );

    return {
      success: false,
      error: 'Já existe uma atividade em execução.',
    };
  }

  sessaoEmExecucao = true;
  notificarAtividade('Publicando anúncios');

  try {
    const tenantDaSessao = exigirSessao();

    // O tenant é sempre obtido da autenticação ativa.
    // O parâmetro externo não pode substituir o tenant autenticado.
    tenantId = tenantDaSessao;

    if (!tenantId) {
      logger.info(
        '📭 Nenhuma empresa vinculada à sessão.'
      );

      return { success: true };
    }

    logger.info(
      '▶ Iniciando sessão local para a empresa vinculada.'
    );

    const resultado = await processarEmpresa(
      tenantId,
      incluirAgendados,
      targetPropertyId
    );

    return {
      success: resultado.success === true,
      error: resultado.error,
    };
  } catch (err) {
    logger.error(
      `ERRO CRÍTICO NA SESSÃO: ${err.message}`
    );

    return {
      success: false,
      error: err.message,
    };
  } finally {
    sessaoEmExecucao = false;
    notificarAtividade('');
  }
}

// ──────────────────────────────────────────────────────────────
// Conexão manual das contas Facebook
// ──────────────────────────────────────────────────────────────

async function conectarContasFacebook() {
  if (sessaoEmExecucao || conectandoFacebook) {
    logger.warn(
      'Já existe uma atividade em andamento no Worker.'
    );

    return;
  }

  conectandoFacebook = true;
  sessaoEmExecucao = true;

  notificarAtividade('Aguardando login do Facebook');

  const headlessOriginal = config.puppeteer.headless;
  const userDataDirOriginal = config.puppeteer.userDataDir;

  let contasConectadas = 0;
  let contasComErro = 0;

  try {
    const tenantId = exigirSessao();

    await panelApi.inicializar(tenantId);

    if (!tenantAtualValido(tenantId)) {
      throw new Error(
        'Sessão encerrada durante a conexão com o painel.'
      );
    }

    const contas = Object.entries(
      config.facebook.contas
    ).filter(
      ([, conta]) => conta.ativa && conta.email
    );

    if (!contas.length) {
      throw new Error(
        'Não há contas ativas. Cadastre e ative uma conta nas Configurações do painel.'
      );
    }

    contasConhecidas = lerContasAtivas();
    emitirStatusFacebook();

    logger.info(
      `🔗 Iniciando conexão de ${contas.length} conta(s) Facebook.`
    );

    for (const [numero, conta] of contas) {
      if (!tenantAtualValido(tenantId)) {
        throw new Error(
          'Sessão encerrada. Conexão interrompida.'
        );
      }

      if (fbSession.estaConectada(conta.userDataDir)) {
        contasConectadas++;
        logger.info(
          `✅ Conta ${numero} (${conta.nome || conta.email}) já está conectada neste computador. Se o Facebook pedir login de novo, use "Desconectar Facebook" e conecte outra vez.`
        );
        continue;
      }

      let poster = null;

      try {
        config.puppeteer.headless = false;
        config.puppeteer.userDataDir = conta.userDataDir;

        notificarAtividade(
          `Conectando Facebook — conta ${numero}`
        );

        if (typeof logger.setAccountNumber === 'function') {
          logger.setAccountNumber(numero);
        }

        logger.info(
          `🌐 Abrindo navegador para a conta ${numero}: ${conta.email}`
        );

        poster = new FacebookPoster();

        await poster.iniciar();

        if (!poster.page || poster.page.isClosed()) {
          throw new Error(
            'O navegador foi fechado antes de abrir o Facebook.'
          );
        }

        await poster.page.bringToFront().catch(() => {});

        await poster.page.goto(
          'https://www.facebook.com/login',
          {
            waitUntil: 'domcontentloaded',
            timeout: 40000,
          }
        );

        logger.info(
          `🌐 Página aberta: ${poster.page.url()}`
        );

        logger.info(
          `🔐 Conta ${numero}: faça login e conclua as confirmações na janela do Facebook.`
        );

        const loginConcluido =
          await poster._aguardarLoginManual(
            10 * 60 * 1000
          );

        if (loginConcluido === false) {
          throw new Error(
            'O login não foi concluído dentro do tempo disponível.'
          );
        }

        contasConectadas++;
        await fbSession.marcarConectada(conta.userDataDir);
        emitirStatusFacebook();

        logger.info(
          `✅ Conta ${numero}: processo de login concluído.`
        );
      } catch (error) {
        contasComErro++;

        logger.error(
          `❌ Falha na conexão da conta ${numero}: ${error.message}`
        );

        // Uma conta com erro não impede as demais
        // de tentarem realizar a conexão.
      } finally {
        if (poster) {
          try {
            await poster.fechar();
          } catch (error) {
            logger.warn(
              `Falha ao fechar navegador da conta ${numero}: ${error.message}`
            );
          }
        }

        if (typeof logger.setAccountNumber === 'function') {
          logger.setAccountNumber(null);
        }
      }
    }

    emitirStatusFacebook();

    logger.info(
      `🏁 Conexão Facebook finalizada — Sucesso: ${contasConectadas} | Erros: ${contasComErro}`
    );

    if (contasComErro > 0) {
      logger.warn(
        '⚠️ Verifique as contas que apresentaram erro e tente conectá-las novamente.'
      );
    }
  } catch (error) {
    logger.error(
      `Falha ao conectar Facebook: ${error.message}`
    );
  } finally {
    config.puppeteer.headless = headlessOriginal;
    config.puppeteer.userDataDir = userDataDirOriginal;

    try {
      panelApi.limparCredenciais();
    } catch (error) {
      logger.warn(
        `Falha ao limpar credenciais: ${error.message}`
      );
    }

    if (typeof logger.setAccountNumber === 'function') {
      logger.setAccountNumber(null);
    }

    if (typeof logger.setPropertyId === 'function') {
      logger.setPropertyId(null);
    }

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(null);
    }

    conectandoFacebook = false;
    sessaoEmExecucao = false;

    notificarAtividade('');
  }
}

// ──────────────────────────────────────────────────────────────
// Comandos globais
// ──────────────────────────────────────────────────────────────

const executarPostagemManual = () =>
  executarSessao().catch((err) => {
    logger.error(
      `Falha na postagem manual: ${err.message}`
    );
  });

global.__anunciaPostNow = executarPostagemManual;
global.__anunciaConnectFacebook = conectarContasFacebook;

// ──────────────────────────────────────────────────────────────
// Validação da conexão com o painel
// ──────────────────────────────────────────────────────────────

async function validarConexao() {
  const tenantId = session.tenantId;

  if (!tenantId || !session.isAuthenticated()) {
    return;
  }

  if (tenantId === tenantValidado) {
    return;
  }

  if (validacaoEmAndamento) {
    return validacaoEmAndamento;
  }

  validacaoEmAndamento = (async () => {
    try {
      if (typeof logger.setTenantId === 'function') {
        logger.setTenantId(tenantId);
      }

      await panelApi.inicializar(tenantId);

      if (!tenantAtualValido(tenantId)) {
        throw new Error(
          'A sessão foi alterada durante a validação.'
        );
      }

      const total = Object.values(
        config.facebook.contas
      ).filter(
        (conta) => conta.ativa && conta.email
      ).length;

      tenantValidado = tenantId;
      contasConhecidas = lerContasAtivas();
      emitirStatusFacebook();

      logger.info(
        `✅ Conexão com o painel validada: ${total} conta(s) ativa(s) recebida(s).`
      );
    } catch (error) {
      tenantValidado = null;

      logger.error(
        `❌ Não foi possível carregar as contas do painel: ${error.message}`
      );
    } finally {
      try {
        panelApi.limparCredenciais();
      } catch (error) {
        logger.warn(
          `Falha ao limpar credenciais: ${error.message}`
        );
      }

      if (typeof logger.setTenantId === 'function') {
        logger.setTenantId(null);
      }

      validacaoEmAndamento = null;
    }
  })();

  return validacaoEmAndamento;
}

// ──────────────────────────────────────────────────────────────
// Comunicação IPC com Electron
// ──────────────────────────────────────────────────────────────

process.on('message', (message) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'auth') {
    if (!message.accessToken || !message.tenantId) {
      logger.warn(
        'Mensagem de autenticação recebida sem token ou tenant.'
      );

      return;
    }

    const tenantAnterior = session.tenantId;

    if (
      tenantAnterior &&
      tenantAnterior !== message.tenantId
    ) {
      tenantValidado = null;
    }

    session.set({
      accessToken: message.accessToken,
      tenantId: message.tenantId,
    });

    validarConexao();
    sincronizarAgenda();
    return;
  }

  if (message.type === 'auth-cleared') {
    session.clear();
    pararAgenda();

    tenantValidado = null;
    validacaoEmAndamento = null;
    contasConhecidas = [];
    emitirStatusFacebook();

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(null);
    }

    if (typeof logger.setPropertyId === 'function') {
      logger.setPropertyId(null);
    }

    if (typeof logger.setAccountNumber === 'function') {
      logger.setAccountNumber(null);
    }

    logger.info(
      '🔒 Sessão do usuário encerrada no Worker.'
    );

    return;
  }

  if (message.type === 'post-now') {
    logger.info(
      '[IPC] Comando recebido: post-now'
    );

    executarPostagemManual();
    return;
  }

  if (message.type === 'connect-facebook') {
    logger.info(
      '[IPC] Comando recebido: connect-facebook'
    );

    conectarContasFacebook();
    return;
  }

  if (message.type === 'disconnect-facebook') {
    logger.info('[IPC] Comando recebido: disconnect-facebook');

    desconectarFacebook();
    return;
  }

  if (message.type === 'fb-status-request') {
    emitirStatusFacebook();
  }
});

async function desconectarFacebook() {
  if (sessaoEmExecucao || conectandoFacebook) {
    logger.warn('Há uma atividade em andamento. Aguarde terminar para desconectar o Facebook.');
    return;
  }

  sessaoEmExecucao = true;
  notificarAtividade('Desconectando Facebook');

  try {
    const tenantId = exigirSessao();
    await fbSession.desconectarTudo(tenantId);
    emitirStatusFacebook();
    logger.info('🔓 Facebook desconectado neste computador: sessões e cookies foram apagados. Para publicar de novo, conecte as contas outra vez.');
  } catch (error) {
    logger.error(`Falha ao desconectar o Facebook: ${error.message}`);
  } finally {
    sessaoEmExecucao = false;
    notificarAtividade('');
  }
}

// ──────────────────────────────────────────────────────────────
// Scheduler e fila de comandos
// ──────────────────────────────────────────────────────────────

let tarefasCron = [];
let assinaturaAgenda = null;

function pararAgenda() {
  tarefasCron.forEach((tarefa) => tarefa.stop());
  tarefasCron = [];
  assinaturaAgenda = null;
}

// Busca no painel os horários da empresa (planos ELITE e ENTERPRISE) e agenda as postagens.
async function sincronizarAgenda() {
  if (workerEncerrando || !session.isAuthenticated() || session.blocked) return;

  try {
    const agenda = await panelApi.buscarAgenda(session.tenantId);
    const horarios = agenda.enabled ? [...new Set(agenda.times)].sort() : [];
    const assinatura = horarios.join(',');

    if (assinatura === assinaturaAgenda) return;

    tarefasCron.forEach((tarefa) => tarefa.stop());
    tarefasCron = horarios.map((horario) => {
      const [hh, mm] = horario.split(':').map(Number);

      return cron.schedule(
        `${mm} ${hh} * * *`,
        () => {
          if (workerEncerrando) return;

          logger.info(`🔔 Horário agendado ${horario}: iniciando postagens pendentes.`);

          executarSessao().catch((err) => {
            logger.error(`Erro na postagem agendada: ${err.message}`);
          });
        },
        { timezone: 'America/Sao_Paulo' }
      );
    });
    assinaturaAgenda = assinatura;

    logger.info(
      horarios.length
        ? `⏰ Postagem automática agendada para: ${horarios.join(', ')} (horário de Brasília).`
        : '⏰ Nenhum horário de postagem agendado (publicação manual pelo botão "Publicar agora").'
    );
  } catch (error) {
    logger.warn(`Não foi possível consultar a agenda do painel: ${error.message}`);
  }
}

function iniciarScheduler() {
  logger.info('⏰ Scheduler iniciado. Os horários vêm do painel (planos com agendamento).');
  logger.info('🔗 Worker local conectado ao painel AnuncIA.');

  setInterval(sincronizarAgenda, 5 * 60 * 1000);
}

// ──────────────────────────────────────────────────────────────
// Consulta de comandos do painel
// ──────────────────────────────────────────────────────────────

async function consultarFilaDeComandos() {
  if (
    workerEncerrando ||
    consultandoFila ||
    sessaoEmExecucao ||
    conectandoFacebook ||
    !session.isAuthenticated()
  ) {
    return;
  }

  consultandoFila = true;

  try {
    const tenantId = exigirSessao();

    const command = await panelApi.buscarComando(
      tenantId
    );

    if (!command) {
      return;
    }

    if (!tenantAtualValido(tenantId)) {
      logger.warn(
        'Comando ignorado porque a sessão foi alterada.'
      );

      return;
    }

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(tenantId);
    }

    logger.info(
      `⚡ Pedido manual de postagem recebido: ${command.id}`
    );

    const resultado = await executarSessao({
      incluirAgendados: false,
      tenantId,
      targetPropertyId: command.propertyId || null,
    });

    // Não registra o resultado de um comando em outro tenant.
    if (!tenantAtualValido(tenantId)) {
      logger.warn(
        'Sessão alterada antes da finalização do comando.'
      );

      return;
    }

    await panelApi.finalizarComando(
      tenantId,
      command.id,
      resultado?.success === true,
      resultado?.error
    );
  } catch (err) {
    logger.error(
      `Falha ao processar pedido manual: ${err.message}`
    );
  } finally {
    consultandoFila = false;

    if (typeof logger.setTenantId === 'function') {
      logger.setTenantId(null);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Inicialização
// ──────────────────────────────────────────────────────────────

iniciarScheduler();

logger.info(
  '🔄 Consultando pedidos de postagem do painel a cada 15 segundos.'
);

consultarFilaDeComandos();

const intervaloFila = setInterval(
  consultarFilaDeComandos,
  15000
);

intervaloFila.unref?.();

// ──────────────────────────────────────────────────────────────
// Encerramento gracioso
// ──────────────────────────────────────────────────────────────

process.on('disconnect', () => {
  workerEncerrando = true;

  clearInterval(intervaloFila);

  session.clear();

  logger.info(
    '🔌 Comunicação com o Electron encerrada.'
  );
});

process.on('SIGTERM', () => {
  workerEncerrando = true;
  clearInterval(intervaloFila);
});

process.on('SIGINT', () => {
  workerEncerrando = true;
  clearInterval(intervaloFila);
});
