// Estado local da conexão com o Facebook (somente neste computador).
// Cada conta tem um perfil do navegador em chrome-profiles/<empresa>/conta<N>; o marcador
// indica que o cliente já entrou nessa conta e a sessão está salva.
const fs = require('fs-extra');
const path = require('path');

const MARCADOR = '.anuncia-conectada.json';

const raizPerfis = (tenantId) =>
  path.resolve(process.env.WORKER_DATA_DIR || process.cwd(), 'chrome-profiles', tenantId);

const estaConectada = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, MARCADOR));

async function marcarConectada(dir) {
  if (!dir) return;
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, MARCADOR), { conectadoEm: new Date().toISOString() });
}

async function desmarcar(dir) {
  if (dir) await fs.remove(path.join(dir, MARCADOR));
}

// Apaga todos os perfis (cookies e sessões) das contas da empresa neste computador.
async function desconectarTudo(tenantId) {
  await fs.remove(raizPerfis(tenantId));
}

module.exports = { estaConectada, marcarConectada, desmarcar, desconectarTudo };
