// Atualização remota: verifica novas versões no GitHub Releases e instala dentro do app.
const { autoUpdater } = require('electron-updater');

function criarAtualizador({ app, log, enviar, antesDeInstalar }) {
  let estado = { estado: 'nenhuma', versaoAtual: app.getVersion() };
  let obrigatoria = false;
  let ultimaVersao = '';

  const definir = (patch) => {
    estado = { versaoAtual: app.getVersion(), obrigatoria, ...patch };
    enviar(estado);
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    ultimaVersao = info.version;
    definir({ estado: 'disponivel', versao: info.version });
    log('info', `Nova versão disponível: ${info.version}.`);
    if (obrigatoria) baixar();
  });
  autoUpdater.on('update-not-available', () => definir({ estado: 'atualizado' }));
  autoUpdater.on('download-progress', (p) =>
    definir({ estado: 'baixando', versao: ultimaVersao, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    definir({ estado: 'pronta', versao: info.version });
    log('info', `Atualização ${info.version} baixada e pronta para instalar.`);
    if (obrigatoria) instalar();
  });
  autoUpdater.on('error', (error) => {
    log('warn', `Atualização: ${error?.message || error}`);
    definir({ estado: 'erro', versao: ultimaVersao });
  });

  async function verificar() {
    if (!app.isPackaged) return;
    try { await autoUpdater.checkForUpdates(); } catch (error) { log('warn', `Não foi possível verificar atualizações: ${error.message}`); }
  }
  function baixar() {
    autoUpdater.downloadUpdate().catch((error) => log('warn', `Falha ao baixar a atualização: ${error.message}`));
  }
  function instalar() {
    log('info', 'Reiniciando para instalar a atualização...');
    antesDeInstalar();
    autoUpdater.quitAndInstall(true, true);
  }
  function exigir() { obrigatoria = true; verificar(); }
  function iniciarAgenda() {
    setTimeout(verificar, 15000);
    setInterval(verificar, 4 * 60 * 60 * 1000);
  }

  return { verificar, baixar, instalar, exigir, iniciarAgenda, estado: () => estado };
}

module.exports = { criarAtualizador };
