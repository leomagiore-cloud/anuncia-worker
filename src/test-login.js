require('dotenv').config();
const config = require('./config');
const logger = require('./logger');
const FacebookPoster = require('./poster');
const path = require('path');

(async () => {
  const accountId = Number(process.argv[2] || 1);
  const account = config.facebook.contas[accountId];
  if (!account) throw new Error('Número de conta inválido. Use 1, 2 ou 3.');
  config.puppeteer.userDataDir = path.resolve(process.env.WORKER_DATA_DIR || process.cwd(), 'facebook-profiles', `conta${accountId}`);
  config.puppeteer.headless = false;
  const poster = new FacebookPoster();
  try {
    await poster.iniciar();
    await poster.page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
    await poster._aguardarLoginManual(10 * 60 * 1000);
    logger.info('Sessão local salva. Nas publicações futuras o Worker tentará usar o modo invisível.');
  } finally {
    await poster.fechar();
  }
})().catch((error) => { logger.error(error.message); process.exit(1); });
