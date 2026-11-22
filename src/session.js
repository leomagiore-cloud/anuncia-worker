
'use strict';

// Sessão do usuário dentro do processo do Worker (somente em memória).
// O login, o armazenamento seguro e a renovação do token ficam no
// processo principal do Electron. O Worker recebe o token via IPC.

const { EventEmitter } = require('events');

const events = new EventEmitter();

const baseUrl = (
  process.env.PANEL_API_URL ||
  'https://anunciamarketplace.vercel.app'
).replace(/\/+$/, '');

let state = {
  accessToken: null,
  tenantId: null,
};

let pending = null;

// ── Atualização da sessão ──
function set({ accessToken, tenantId } = {}) {
  state = {
    accessToken: accessToken || null,
    tenantId: tenantId || null,
  };

  events.emit('updated');
}

// ── Limpeza da sessão ──
function clear() {
  state = {
    accessToken: null,
    tenantId: null,
  };

  blocked = null;
  events.emit('cleared');
}

// ── Renovação de sessão via Electron ──
// O Worker solicita a renovação ao processo principal.
// O Electron responde enviando uma nova mensagem IPC de autenticação.

function refresh() {
  if (pending) {
    return pending;
  }

  pending = new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(
        new Error(
          'Sessão expirada. Entre novamente no AnuncIA Worker.'
        )
      );

      return;
    }

    let finalizado = false;

    const finish = (callback, value) => {
      if (finalizado) return;

      finalizado = true;

      clearTimeout(timer);

      events.off('updated', onUpdated);
      events.off('cleared', onCleared);

      callback(value);
    };

    const onUpdated = () => {
      if (!state.accessToken || !state.tenantId) {
        finish(
          reject,
          new Error(
            'O painel não retornou uma sessão válida.'
          )
        );

        return;
      }

      finish(resolve);
    };

    const onCleared = () => {
      finish(
        reject,
        new Error(
          'Sessão encerrada. Entre novamente no AnuncIA Worker.'
        )
      );
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          'Tempo esgotado ao renovar a sessão.'
        )
      );
    }, 20000);

    events.once('updated', onUpdated);
    events.once('cleared', onCleared);

    try {
      process.send(
        { type: 'auth-refresh' },
        (error) => {
          if (error) {
            finish(
              reject,
              new Error(
                `Falha ao solicitar renovação da sessão: ${error.message}`
              )
            );
          }
        }
      );
    } catch (error) {
      finish(
        reject,
        new Error(
          `Falha na comunicação com o Electron: ${error.message}`
        )
      );
    }
  }).finally(() => {
    pending = null;
  });

  return pending;
}

// Bloqueio remoto (manutenção, conta suspensa, plano inativo, versão obrigatória).
let blocked = null;

function setBlocked(info) {
  if (blocked && blocked.code === info.code && blocked.message === info.message) return;
  blocked = info;
  events.emit('blocked', blocked);
}

function clearBlocked(codes) {
  if (!blocked || (codes && !codes.includes(blocked.code))) return;
  blocked = null;
  events.emit('blocked', null);
}

module.exports = {
  baseUrl,
  events,
  set,
  clear,
  refresh,
  setBlocked,
  clearBlocked,

  get blocked() {
    return blocked;
  },

  get accessToken() {
    return state.accessToken;
  },

  get tenantId() {
    return state.tenantId;
  },

  isAuthenticated() {
    return Boolean(
      state.accessToken && state.tenantId
    );
  },
};
