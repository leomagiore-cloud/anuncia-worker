require('dotenv').config();
const path = require('path');
const fs = require('fs');

function detectarChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform !== 'win32') return undefined;
  const candidatos = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidatos.find((arquivo) => arquivo && fs.existsSync(arquivo));
}

module.exports = {
  facebook: {
    email: '',
    urlMarketplace: 'https://www.facebook.com/marketplace/create/item',
    urlLogin: 'https://www.facebook.com/login',
    whatsapp: '',
    creci: '',
    
    // Accounts and credentials are loaded for each tenant from the panel API.
    contas: {
      1: {
        nome: 'Conta Principal',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: ''
      },
      2: {
        nome: 'Conta Secundária',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: ''
      },
      3: {
        nome: 'Conta Terciária',
        email: '',
        userDataDir: '',
        ativa: false,
        whatsapp: '',
        creci: ''
      }
    }
  },
  postagem: {
    tempImagesDir: path.resolve(process.env.TEMP_IMAGES_DIR || path.join(process.env.WORKER_DATA_DIR || process.cwd(), 'temp-images')),
    imagensBaseDir: process.env.IMAGENS_BASE_DIR || '',
    delayEntrePostsMs: 120 * 1000,
    maxPorSessao: 5,
    cron: {
      horario1: process.env.CRON_HORARIO_1 || '0 8 * * *',
      horario2: process.env.CRON_HORARIO_2 || '0 13 * * *',
      horario3: process.env.CRON_HORARIO_3 || '0 18 * * *',
    }
  },

  puppeteer: {
    userDataDir: path.resolve(process.env.CHROME_USER_DATA || path.join(process.env.WORKER_DATA_DIR || process.cwd(), 'chrome-profile')),
    headless: process.env.HEADLESS !== 'false',
    executablePath: detectarChrome(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
      '--lang=pt-BR',
    ],
    defaultViewport: { width: 1366, height: 768 },
    timeout: 60000,
  },

  categoriasFB: {
    'Casa': 'Residencial à venda',
    'Apartamento': 'Residencial à venda',
    'Terreno': 'Terreno à venda',
    'Comercial': 'Comercial',
    'Cobertura': 'Residencial à venda',
    'Studio': 'Residencial à venda',
    'Kitnet': 'Residencial para alugar',
    'Aluguel': 'Residencial para alugar',
  }
};