
require('dotenv').config();

const path = require('path');
const fs = require('fs');

function detectarNavegadores() {
  if (process.env.CHROME_PATH) {
    const caminho = path.resolve(process.env.CHROME_PATH);

    return fs.existsSync(caminho) ? [caminho] : [];
  }

  if (process.platform !== 'win32') {
    return [];
  }

  const pf =
    process.env.PROGRAMFILES || 'C:\\Program Files';

  const pf86 =
    process.env['PROGRAMFILES(X86)'] ||
    'C:\\Program Files (x86)';

  const local = process.env.LOCALAPPDATA || '';

  const caminhos = [
    path.join(
      pf,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      pf86,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      local,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      pf86,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    path.join(
      pf,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
  ];

  return [
    ...new Set(
      caminhos.filter(
        (arquivo) =>
          arquivo && fs.existsSync(arquivo)
      )
    ),
  ];
}

const detectarChrome = () => detectarNavegadores()[0] || null;

const workerDataDir = path.resolve(
  process.env.WORKER_DATA_DIR || process.cwd()
);

const tempImagesDir = path.resolve(
  process.env.TEMP_IMAGES_DIR ||
    path.join(workerDataDir, 'temp-images')
);

const chromeUserDataDir = path.resolve(
  process.env.CHROME_USER_DATA ||
    path.join(workerDataDir, 'chrome-profile')
);

module.exports = {
  facebook: {
    email: '',
    urlMarketplace:
      'https://www.facebook.com/marketplace/create/item',
    urlLogin:
      'https://www.facebook.com/login',
    whatsapp: '',
    creci: '',

    // As contas e credenciais são carregadas
    // individualmente para cada tenant pela API do painel.
    contas: {
      1: {
        nome: 'Conta Principal',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: '',
      },

      2: {
        nome: 'Conta Secundária',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: '',
      },

      3: {
        nome: 'Conta Terciária',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: '',
      },
    },
  },

  postagem: {
    tempImagesDir,
    imagensBaseDir: process.env.IMAGENS_BASE_DIR || '',

    delayEntrePostsMs: 120 * 1000,
    maxPorSessao: 5,

    cron: {
      horario1:
        process.env.CRON_HORARIO_1 || '0 8 * * *',

      horario2:
        process.env.CRON_HORARIO_2 || '0 13 * * *',

      horario3:
        process.env.CRON_HORARIO_3 || '0 18 * * *',
    },
  },

  puppeteer: {
    userDataDir: chromeUserDataDir,

    headless: process.env.HEADLESS !== 'false',

    executablePath: detectarChrome(),

    executablePaths: detectarNavegadores(),

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
      '--lang=pt-BR',
      '--no-first-run',
      '--no-default-browser-check',
    ],

    defaultViewport: {
      width: 1366,
      height: 768,
    },

    timeout: 60000,
  },

  categoriasFB: {
    Casa: 'Residencial à venda',
    Apartamento: 'Residencial à venda',
    Terreno: 'Terreno à venda',
    Comercial: 'Comercial',
    Cobertura: 'Residencial à venda',
    Studio: 'Residencial à venda',
    Kitnet: 'Residencial para alugar',
    Aluguel: 'Residencial para alugar',
  },
};
