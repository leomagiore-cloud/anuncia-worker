require('dotenv').config();

  const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
  const { fork } = require('child_process');
  const path = require('path');
  const updater = require('./src/updateManager');

  let mainWindow = null;
  let tray = null;
  let worker = null;
  let workerOnline = false;
  let workerActivity = '';
  let logs = [];

  function log(level, message) {
    const entry = { nivel: level, msg: String(message).trim(), ts: new Date().toLocaleTimeString('pt-BR') };
    if (!entry.msg) return;
    logs.unshift(entry);
    if (logs.length > 300) logs.pop();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', entry);
  }

  function setStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', { online: workerOnline, atividade: workerActivity });
    atualizarTray();
  }

  function iniciarWorker() {
    if (worker) return;
    const required = ['PANEL_API_URL', 'PANEL_WORKER_TOKEN', 'WORKER_TENANT_ID'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
      log('error', `Configuração incompleta no .env: ${missing.join(', ')}.`);
      log('warn', 'Esta versão de teste usa o token global do worker. Não distribua o instalador a clientes.');
      setStatus();
      return;
    }

    const workerScript = path.join(__dirname, 'index.js');
    worker = fork(workerScript, [], {
      cwd: app.getPath('userData'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ANUNCIA_WORKER_CHILD: '1',
        WORKER_DATA_DIR: app.getPath('userData'),
        HEADLESS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const handleOutput = (level) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith('@@ANUNCIA_STATE ')) {
          try { workerActivity = JSON.parse(line.slice(16)).atividade || ''; setStatus(); } catch {}
        } else log(level, line);
      }
    };
    worker.stdout.on('data', handleOutput('info'));
    worker.stderr.on('data', handleOutput('error'));
    worker.on('message', (message) => {
      if (message?.type === 'state') {
        workerActivity = message.atividade || '';
        setStatus();
      }
    });
    worker.on('spawn', () => { workerOnline = true; log('info', 'AnuncIA Worker iniciado. Agendamento e fila do painel ativos.'); setStatus(); });
    worker.on('exit', (code) => {
      workerOnline = false; workerActivity = ''; worker = null;
      log(code === 0 ? 'warn' : 'error', `Worker encerrado (código ${code}).`); setStatus();
    });
    worker.on('error', (error) => log('error', `Falha ao iniciar worker: ${error.message}`));
  }

  function enviarWorker(message) {
    if (!worker) {
      log('error', `Não foi possível enviar o comando ${message.type}: Worker não iniciado.`);
      return;
    }
    if (typeof worker.send !== 'function' || !worker.connected) {
      log('error', `Não foi possível enviar ${message.type}: canal IPC indisponível.`);
      return;
    }
    log('info', `Enviando comando IPC ao Worker: ${message.type}`);
    worker.send(message, (error) => {
      if (error) log('error', `Falha ao enviar comando ao Worker: ${error.message}`);
      else log('info', `Comando ${message.type} entregue ao canal IPC.`);
    });
  }

  function criarJanela() {
    mainWindow = new BrowserWindow({
      width: 900, height: 640, minWidth: 760, minHeight: 520,
      frame: false, backgroundColor: '#10131b', show: false,
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'electron-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    mainWindow.loadFile(path.join(__dirname, 'ui-index.html'));
    mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.webContents.send('logs-iniciais', [...logs].reverse()); setStatus(); });
    mainWindow.on('close', (event) => { if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  }

  function atualizarTray() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `AnuncIA Worker — ${workerOnline ? 'Online' : 'Offline'}`, enabled: false },
      { type: 'separator' },
      { label: 'Abrir AnuncIA Worker', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: 'Conectar Facebook', enabled: workerOnline && !workerActivity, click: () => enviarWorker({ type: 'connect-facebook' }) },
      { label: 'Publicar agora', enabled: workerOnline && !workerActivity, click: () => enviarWorker({ type: 'post-now' }) },
      { type: 'separator' },
      { label: 'Abrir painel AnuncIA', click: () => process.env.PANEL_API_URL && shell.openExternal(process.env.PANEL_API_URL) },
      { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.setToolTip(`AnuncIA Worker — ${workerOnline ? 'Online' : 'Offline'}`);
  }

  ipcMain.on('update-download', () => updater.downloadUpdate());
  ipcMain.on('update-install', () => updater.installUpdate());

  ipcMain.on('cmd', (_, command) => {
    log('info', `Ação recebida da interface: ${command}`);
    if (command === 'minimizar') mainWindow?.minimize();
    if (command === 'fechar') mainWindow?.hide();
    if (command === 'postar-agora') enviarWorker({ type: 'post-now' });
    if (command === 'conectar-facebook') enviarWorker({ type: 'connect-facebook' });
    if (command === 'abrir-painel' && process.env.PANEL_API_URL) shell.openExternal(process.env.PANEL_API_URL);
    if (command === 'reiniciar-worker') {
      if (worker) { worker.once('exit', () => setTimeout(iniciarWorker, 900)); worker.kill(); }
      else iniciarWorker();
    }
  });

  app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: true });
    criarJanela();
    updater.initializeUpdater(mainWindow);
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.on('click', () => mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()));
    atualizarTray(); iniciarWorker();
  });

  app.on('before-quit', () => { app.isQuitting = true; if (worker) worker.kill(); });
  app.on('window-all-closed', (event) => event.preventDefault());
