
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  shell,
  safeStorage,
} = require('electron');

const { fork } = require('child_process');
const path = require('path');
const { criarAtualizador } = require('./electron-update');
const fs = require('fs');

// Em produção o endereço do painel é fixo.
// Em desenvolvimento, permite sobrescrever com ANUNCIA_PANEL_URL.
const PANEL_URL = (
  (!app.isPackaged && process.env.ANUNCIA_PANEL_URL) ||
  'https://anunciamarketplace.vercel.app'
).replace(/\/+$/, '');

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let worker = null;
let workerOnline = false;
let workerActivity = '';
let logs = [];
let reconectando = false;
let fbStatus = [];
let bloqueio = null;
let atualizador = null;
let encerrandoAplicativo = false;

// ── Sessão do usuário ──
// Access token somente em memória.
// Refresh token armazenado criptografado pelo Electron.
let auth = {
  accessToken: null,
  refreshToken: null,
  tenantId: null,
  user: null,
  expiresAt: 0,
};

let refreshTimer = null;
let renovando = null;

const autenticado = () =>
  Boolean(auth.accessToken && auth.tenantId);

const arquivoSessao = () =>
  path.join(app.getPath('userData'), 'session.bin');

// ── Logs ──
function log(level, message) {
  const entry = {
    nivel: level,
    msg: String(message || '').trim(),
    ts: new Date().toLocaleTimeString('pt-BR'),
  };

  if (!entry.msg) return;

  logs.unshift(entry);

  if (logs.length > 300) {
    logs.pop();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry);
  }
}

// ── Armazenamento seguro da sessão ──
function salvarSessao() {
  try {
    if (!auth.refreshToken) return;

    if (!safeStorage.isEncryptionAvailable()) {
      log(
        'warn',
        'Criptografia do sistema indisponível. A sessão não será salva neste computador.'
      );
      return;
    }

    const conteudo = safeStorage.encryptString(
      JSON.stringify({
        refreshToken: auth.refreshToken,
      })
    );

    const destino = arquivoSessao();
    const temporario = `${destino}.tmp`;

    fs.writeFileSync(temporario, conteudo);
    fs.renameSync(temporario, destino);
  } catch (error) {
    log(
      'warn',
      `Não foi possível salvar a sessão neste computador: ${error.message}`
    );
  }
}

function lerSessaoSalva() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }

    if (!fs.existsSync(arquivoSessao())) {
      return null;
    }

    const conteudo = fs.readFileSync(arquivoSessao());
    const dados = JSON.parse(
      safeStorage.decryptString(conteudo)
    );

    if (
      !dados ||
      typeof dados.refreshToken !== 'string' ||
      !dados.refreshToken
    ) {
      return null;
    }

    return dados;
  } catch (error) {
    log(
      'warn',
      `Não foi possível recuperar a sessão salva: ${error.message}`
    );

    return null;
  }
}

function apagarSessaoSalva() {
  try {
    if (fs.existsSync(arquivoSessao())) {
      fs.unlinkSync(arquivoSessao());
    }
  } catch (error) {
    log(
      'warn',
      `Não foi possível apagar a sessão salva: ${error.message}`
    );
  }
}

// ── Comunicação com o painel ──
async function chamarPainel(rota, body) {
  const response = await fetch(
    `${PANEL_URL}/api/worker/auth/${rota}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Version': app.getVersion(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error || `Painel respondeu HTTP ${response.status}`
    );

    error.status = response.status;
    error.code = data.code;
    throw error;
  }

  return data;
}

// ── Aplicação da sessão ──
function aplicarSessao(data) {
  if (
    !data?.accessToken ||
    !data?.refreshToken ||
    !data?.tenantId
  ) {
    throw new Error(
      'Resposta de autenticação inválida do painel.'
    );
  }

  const expiresAt = Number(data.expiresAt);

  auth = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    tenantId: data.tenantId,
    user: data.user || auth.user,
    expiresAt:
      Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt
        : Math.floor(Date.now() / 1000) + 3300,
  };

  salvarSessao();
  agendarRenovacao();
}

// ── Renovação automática ──
function agendarRenovacao() {
  clearTimeout(refreshTimer);
  refreshTimer = null;

  if (!auth.refreshToken || !auth.expiresAt) {
    return;
  }

  // Renova cinco minutos antes da expiração.
  const tempoRestante =
    auth.expiresAt * 1000 -
    Date.now() -
    5 * 60 * 1000;

  const minimoMs = 30000;
  const proximaTentativa = Math.max(
    minimoMs,
    tempoRestante
  );

  refreshTimer = setTimeout(() => {
    renovarSessao().catch(() => {});
  }, proximaTentativa);
}

function renovarSessao() {
  if (!renovando) {
    renovando = renovarSessaoInterno().finally(() => {
      renovando = null;
    });
  }

  return renovando;
}

async function renovarSessaoInterno() {
  if (!auth.refreshToken) {
    throw new Error('Não existe uma sessão para renovar.');
  }

  try {
    const dados = await chamarPainel('refresh', {
      refreshToken: auth.refreshToken,
    });

    aplicarSessao(dados);
    aoAutenticar();

    log('info', 'Sessão renovada com sucesso.');
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) {
      encerrarSessao(
        error.status === 403
          ? error.message
          : 'Sua sessão expirou. Entre novamente.'
      );
    } else {
      // Erros de conexão não encerram a sessão.
      // O aplicativo tentará renovar novamente.
      log(
        'warn',
        `Não foi possível renovar a sessão agora: ${error.message}`
      );

      clearTimeout(refreshTimer);

      refreshTimer = setTimeout(() => {
        renovarSessao().catch(() => {});
      }, 15000);
    }

    throw error;
  }
}

// ── Encerramento da sessão ──
function encerrarSessao(motivo = '') {
  clearTimeout(refreshTimer);
  refreshTimer = null;

  reconectando = false;

  auth = {
    accessToken: null,
    refreshToken: null,
    tenantId: null,
    user: null,
    expiresAt: 0,
  };

  apagarSessaoSalva();
  fbStatus = [];
  bloqueio = null;
  enviarFbStatusUI();
  enviarBloqueioUI();
  pararWorker();

  enviarSessaoUI(motivo);
  atualizarTray();

  log('info', 'Sessão encerrada.');
}

// ── Autenticação concluída ──
function aoAutenticar() {
  reconectando = false;

  enviarSessaoUI();

  iniciarWorker();

  // A sessão também é enviada quando o Worker inicia.
  enviarSessaoAoWorker();

  atualizarTray();
}

// ── Envio de sessão ao Worker ──
function enviarSessaoAoWorker() {
  if (!worker || !worker.connected || !autenticado()) {
    return;
  }

  try {
    worker.send(
      {
        type: 'auth',
        accessToken: auth.accessToken,
        tenantId: auth.tenantId,
      },
      (error) => {
        if (error) {
          log(
            'error',
            `Falha ao enviar autenticação ao Worker: ${error.message}`
          );
        }
      }
    );
  } catch (error) {
    log(
      'error',
      `Erro na comunicação com o Worker: ${error.message}`
    );
  }
}

function enviarBloqueioUI() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bloqueio', bloqueio);
}

function enviarUpdateUI(estado) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update', estado || atualizador?.estado());
}

function enviarFbStatusUI() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fb-status', fbStatus);
}

function enviarSessaoUI(motivo = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('sessao', {
    autenticado: autenticado(),
    reconectando,
    email: auth.user?.email || '',
    nome: auth.user?.name || '',
    motivo,
  });
}

// ── Status ──
function setStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', {
      online: workerOnline,
      atividade: workerActivity,
    });
  }

  atualizarTray();
}

// ── Inicialização do Worker ──
function iniciarWorker() {
  if (worker || !autenticado() || encerrandoAplicativo) {
    return;
  }

  const workerScript = path.join(__dirname, 'index.js');

  const novoWorker = fork(workerScript, [], {
    cwd: app.getPath('userData'),

    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKER_VERSION: app.getVersion(),
      ANUNCIA_WORKER_CHILD: '1',
      WORKER_DATA_DIR: app.getPath('userData'),
      PANEL_API_URL: PANEL_URL,
      HEADLESS: 'true',
    },

    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  worker = novoWorker;

  const atual = novoWorker;

  const handleOutput = (level) => (chunk) => {
    const linhas = String(chunk).split(/\r?\n/);

    for (const linha of linhas) {
      if (!linha.trim()) continue;

      if (linha.startsWith('@@ANUNCIA_STATE ')) {
        try {
          const estado = JSON.parse(
            linha.slice('@@ANUNCIA_STATE '.length)
          );

          workerActivity = estado.atividade || '';
          setStatus();
        } catch {
          // Ignora mensagens de status inválidas.
        }
      } else {
        // O winston envia cores ANSI e o nível no início ("error:", "warn:", "info:").
        const limpa = linha.replace(/\u001b\[[0-9;]*m/g, '');
        const m = limpa.match(/^(error|warn|info|debug):\s*([\s\S]*)$/);
        const nivel = m
          ? (m[1] === 'debug' ? 'info' : m[1])
          : (level === 'error' && !/(error|exception|fatal)/i.test(limpa) ? 'warn' : level);
        log(nivel, m ? m[2] : limpa);
      }
    }
  };

  atual.stdout.on('data', handleOutput('info'));
  atual.stderr.on('data', handleOutput('error'));

  atual.on('message', (message) => {
    if (worker !== atual) return;

    if (message?.type === 'state') {
      workerActivity = message.atividade || '';
      setStatus();
    }

    if (message?.type === 'worker-blocked') {
      bloqueio = message.info || null;
      if (bloqueio) log('error', `⛔ Worker PAUSADO: ${bloqueio.message}`);
      else log('info', '✅ Worker liberado: voltando a funcionar normalmente.');
      enviarBloqueioUI();
      atualizarTray();
      if (bloqueio?.code === 'update_required') atualizador?.exigir();
    }

    if (message?.type === 'fb-status') {
      fbStatus = Array.isArray(message.contas) ? message.contas : [];
      enviarFbStatusUI();
      atualizarTray();
    }

    if (message?.type === 'auth-refresh') {
      renovarSessao().catch(() => {});
    }
  });

  atual.on('spawn', () => {
    if (worker !== atual) return;

    workerOnline = true;

    log(
      'info',
      'AnuncIA Worker iniciado. Agendamento e fila do painel ativos.'
    );

    // Envia a sessão quando o processo estiver iniciado.
    enviarSessaoAoWorker();

    setStatus();
  });

  atual.on('exit', (code, signal) => {
    if (worker === atual) {
      workerOnline = false;
      workerActivity = '';
      worker = null;
    }

    const nivel =
      code === 0 || code === null ? 'warn' : 'error';

    log(
      nivel,
      `Worker encerrado (código ${code}, sinal ${signal || 'nenhum'}).`
    );

    setStatus();
  });

  atual.on('error', (error) => {
    log(
      'error',
      `Falha ao iniciar ou comunicar com o Worker: ${error.message}`
    );
  });

  // Envio inicial da sessão.
  enviarSessaoAoWorker();
}

// ── Encerramento do Worker ──
function pararWorker() {
  if (!worker) {
    workerOnline = false;
    workerActivity = '';
    setStatus();
    return;
  }

  const atual = worker;

  // Evita que o evento exit de um processo antigo
  // altere o estado de um Worker novo.
  worker = null;
  workerOnline = false;
  workerActivity = '';

  try {
    if (atual.connected) {
      atual.send({ type: 'auth-cleared' });
    }
  } catch {
    // O processo pode já estar encerrando.
  }

  try {
    if (atual.exitCode === null && !atual.killed) {
      atual.kill();
    }
  } catch (error) {
    log(
      'warn',
      `Não foi possível encerrar o Worker normalmente: ${error.message}`
    );
  }

  setStatus();
}

// ── Envio de comandos ──
function enviarWorker(message) {
  if (!worker) {
    log(
      'error',
      `Não foi possível enviar ${message.type}: Worker não iniciado.`
    );
    return;
  }

  if (
    typeof worker.send !== 'function' ||
    !worker.connected
  ) {
    log(
      'error',
      `Não foi possível enviar ${message.type}: canal IPC indisponível.`
    );
    return;
  }

  log(
    'info',
    `Enviando comando IPC ao Worker: ${message.type}`
  );

  try {
    worker.send(message, (error) => {
      if (error) {
        log(
          'error',
          `Falha ao enviar comando ao Worker: ${error.message}`
        );
      } else {
        log(
          'info',
          `Comando ${message.type} entregue ao canal IPC.`
        );
      }
    });
  } catch (error) {
    log(
      'error',
      `Erro ao enviar comando ao Worker: ${error.message}`
    );
  }
}

// ── Janela principal ──
function criarJanela(mostrar = true) {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#10131b',
    show: false,

    icon: path.join(__dirname, 'assets', 'icon.ico'),

    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(
    path.join(__dirname, 'ui-index.html')
  );

  mainWindow.webContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow.isDestroyed()) return;

    if (mostrar) {
      mainWindow.show();
    }

    mainWindow.webContents.send(
      'logs-iniciais',
      [...logs].reverse()
    );

    setStatus();
    enviarSessaoUI();
    enviarFbStatusUI();
    enviarBloqueioUI();
    enviarUpdateUI();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function mostrarJanela() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

// ── Bandeja do sistema ──
function atualizarTray() {
  if (!tray) return;

  const logado = autenticado();

  const menu = Menu.buildFromTemplate([
    {
      label: `AnuncIA Worker — ${
        logado
          ? workerOnline
            ? 'Online'
            : 'Offline'
          : 'Desconectado'
      }`,
      enabled: false,
    },

    ...(logado && auth.user?.email
      ? [
          {
            label: auth.user.email,
            enabled: false,
          },
        ]
      : []),

    { type: 'separator' },

    {
      label: logado
        ? 'Abrir AnuncIA Worker'
        : 'Entrar na conta AnuncIA',
      click: mostrarJanela,
    },

    ...(fbStatus.some((conta) => conta.conectada)
      ? [{
          label: 'Desconectar Facebook',
          enabled: logado && workerOnline && !workerActivity,
          click: () => enviarWorker({ type: 'disconnect-facebook' }),
        }]
      : []),

    {
      label: 'Conectar Facebook',
      enabled: logado && workerOnline && !workerActivity,
      click: () =>
        enviarWorker({ type: 'connect-facebook' }),
    },

    {
      label: 'Publicar agora',
      enabled: logado && workerOnline && !workerActivity,
      click: () =>
        enviarWorker({ type: 'post-now' }),
    },

    { type: 'separator' },

    {
      label: 'Abrir painel AnuncIA',
      click: () => shell.openExternal(PANEL_URL),
    },

    ...(logado
      ? [
          {
            label: 'Sair da conta',
            click: () => encerrarSessao(),
          },
        ]
      : []),

    {
      label: 'Fechar aplicativo',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.setToolTip(
    `AnuncIA Worker — ${
      logado
        ? workerOnline
          ? 'Online'
          : 'Offline'
        : 'Desconectado'
    }`
  );
}

// ── Login pela interface ──
ipcMain.handle('login', async (_, { email, password } = {}) => {
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email.trim() ||
    !password
  ) {
    return {
      ok: false,
      error: 'Informe o e-mail e a senha da sua conta AnuncIA.',
    };
  }

  try {
    const dados = await chamarPainel('login', {
      email: email.trim(),
      password,
    });

    aplicarSessao(dados);
    aoAutenticar();

    log(
      'info',
      `Conectado como ${auth.user?.email || email.trim()}.`
    );

    return { ok: true };
  } catch (error) {
    if (error.code === 'update_required') atualizador?.exigir();

    return {
      ok: false,
      error: error.status
        ? error.message
        : `Não foi possível falar com o painel: ${error.message}`,
    };
  }
});

// ── Comandos da interface ──
ipcMain.on('cmd', (_, command) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (command === 'minimizar') {
    mainWindow.minimize();
  }

  if (command === 'fechar') {
    mainWindow.hide();
  }

  if (command === 'postar-agora') {
    enviarWorker({ type: 'post-now' });
  }

  if (command === 'verificar-atualizacao') atualizador?.verificar();
  if (command === 'baixar-atualizacao') atualizador?.baixar();
  if (command === 'instalar-atualizacao') atualizador?.instalar();

  if (command === 'conectar-facebook') {
    enviarWorker({ type: 'connect-facebook' });
  }

  if (command === 'desconectar-facebook') {
    enviarWorker({ type: 'disconnect-facebook' });
  }

  if (command === 'abrir-painel') {
    shell.openExternal(PANEL_URL);
  }

  if (command === 'abrir-cadastro') {
    shell.openExternal(`${PANEL_URL}/cadastro`);
  }

  if (command === 'sair-conta') {
    encerrarSessao();
  }

  if (command === 'reiniciar-worker') {
    if (worker) {
      const atual = worker;

      worker = null;
      workerOnline = false;
      workerActivity = '';

      atual.once('exit', () => {
        if (autenticado() && !encerrandoAplicativo) {
          setTimeout(iniciarWorker, 900);
        }
      });

      try {
        atual.kill();
      } catch (error) {
        log(
          'error',
          `Falha ao reiniciar Worker: ${error.message}`
        );
      }
    } else {
      iniciarWorker();
    }

    setStatus();
  }
});

// ── Eventos do Electron ──
app.on('second-instance', () => {
  mostrarJanela();
});

app.whenReady().then(async () => {
  if (!gotLock) return;

  atualizador = criarAtualizador({
    app,
    log,
    enviar: (estado) => enviarUpdateUI(estado),
    antesDeInstalar: () => { app.isQuitting = true; },
  });
  atualizador.iniciarAgenda();

  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      args: ['--hidden'],
    });
  }

  const iniciarOculto =
    process.argv.includes('--hidden');

  const salva = lerSessaoSalva();

  if (salva?.refreshToken) {
    auth.refreshToken = salva.refreshToken;
    reconectando = true;
  }

  criarJanela(!(iniciarOculto && reconectando));

  const icon = nativeImage.createFromPath(
    path.join(__dirname, 'assets', 'icon.ico')
  );

  tray = new Tray(
    icon.isEmpty()
      ? nativeImage.createEmpty()
      : icon
  );

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mostrarJanela();
    }
  });

  atualizarTray();

  if (reconectando) {
    renovarSessao().catch((error) => {
      if (
        !autenticado() &&
        ![400, 401, 403].includes(error.status)
      ) {
        enviarSessaoUI();
      }
    });
  }
});

// ── Encerramento do aplicativo ──
app.on('before-quit', () => {
  encerrandoAplicativo = true;
  app.isQuitting = true;

  clearTimeout(refreshTimer);
  refreshTimer = null;

  if (worker) {
    const atual = worker;
    worker = null;

    try {
      atual.kill();
    } catch {
      // Processo já encerrado.
    }
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
