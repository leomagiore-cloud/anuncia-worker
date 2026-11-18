const Transport = require('winston-transport');

const MAX_QUEUED_LOGS = 2000;
const MAX_BATCH_SIZE = 100;

class PanelLogTransport extends Transport {
  constructor() {
    super({ level: 'info' });
    this.queue = [];
    this.flushing = false;
    this.lastFailureAt = 0;
    this.tenantId = null;
    this.propertyId = null;
    this.accountNumber = null;
    this.timer = setInterval(() => this.flush(), 1500);
    this.timer.unref();
  }

  setTenantId(tenantId) {
    this.tenantId = tenantId;
  }

  setPropertyId(propertyId) {
    this.propertyId = propertyId;
  }

  setAccountNumber(accountNumber) {
    this.accountNumber = accountNumber;
  }

  log(info, callback) {
    const formatted = info[Symbol.for('message')] ?? info.message ?? '';
    if (this.tenantId) this.queue.push({
      tenantId: this.tenantId,
      propertyId: this.propertyId,
      accountNumber: this.accountNumber,
      level: ['error', 'warn', 'info', 'debug'].includes(info.level) ? info.level : 'info',
      message: String(formatted).slice(0, 4000),
    });

    if (this.queue.length > MAX_QUEUED_LOGS) {
      this.queue.splice(0, this.queue.length - MAX_QUEUED_LOGS);
    }

    setImmediate(() => this.emit('logged', info));
    callback();
  }

  async flush() {
    if (this.flushing || this.queue.length === 0) return;
    const baseUrl = process.env.PANEL_API_URL?.replace(/\/+$/, '');
    const token = process.env.PANEL_WORKER_TOKEN;
    if (!baseUrl || !token) return;

    this.flushing = true;
    const tenantId = this.queue[0].tenantId;
    const batch = [];
    this.queue = this.queue.filter((entry) => {
      if (entry.tenantId !== tenantId || batch.length >= MAX_BATCH_SIZE) return true;
      batch.push(entry);
      return false;
    });
    try {
      const response = await fetch(`${baseUrl}/api/worker/logs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId,
          logs: batch.map(({ level, message, propertyId, accountNumber }) => ({
            level,
            message,
            propertyId,
            accountNumber,
          })),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Painel respondeu HTTP ${response.status}`);
      }
      this.lastFailureAt = 0;
    } catch (error) {
      this.queue.unshift(...batch);
      if (this.queue.length > MAX_QUEUED_LOGS) {
        this.queue.length = MAX_QUEUED_LOGS;
      }
      if (Date.now() - this.lastFailureAt >= 30000) {
        console.error(`[PanelLogTransport] Não foi possível enviar logs ao painel: ${error.message}`);
        this.lastFailureAt = Date.now();
      }
    } finally {
      this.flushing = false;
    }
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}

module.exports = PanelLogTransport;
