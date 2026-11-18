const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

let mainWindow = null;
let updateAvailable = false;
let updateDownloaded = false;

function notify(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

function initializeUpdater(window) {
  mainWindow = window;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => notify({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    notify({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => notify({ state: 'current' }));
  autoUpdater.on('download-progress', (progress) => {
    notify({ state: 'downloading', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    notify({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    notify({ state: 'error', message: error.message });
  });

  autoUpdater.checkForUpdates().catch((error) => {
    notify({ state: 'error', message: error.message });
  });
}

function downloadUpdate() {
  if (updateAvailable && !updateDownloaded) {
    autoUpdater.downloadUpdate().catch((error) => notify({ state: 'error', message: error.message }));
  }
}

function installUpdate() {
  if (updateDownloaded) {
    autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { initializeUpdater, downloadUpdate, installUpdate };
