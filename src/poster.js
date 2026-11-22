
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const fbSession = require('./fbSession');
const config = require('./config');
const logger = require('./logger');

puppeteer.use(StealthPlugin());

const sleep = (min, max) => {
  const ms = max ? Math.random() * (max - min) + min : min;
  return new Promise(resolve => setTimeout(resolve, ms));
};

async function clicarPorTexto(page, texto, timeout = 10000) {
  try {
    await page.waitForXPath(`//*[contains(text(), "${texto}")]`, { timeout });
    const [elemento] = await page.$x(`//*[contains(text(), "${texto}")]`);

    if (elemento) {
      await elemento.click();
      await elemento.dispose().catch(() => {});
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function clicarTextoExato(page, texto) {
  const candidatos = await page.$x(`//*[normalize-space(.)="${texto}"]`);
  const visiveis = [];

  for (const candidato of candidatos) {
    const box = await candidato.boundingBox().catch(() => null);

    if (box && box.width > 0 && box.height > 0) {
      visiveis.push({
        candidato,
        area: box.width * box.height,
      });
    } else {
      await candidato.dispose().catch(() => {});
    }
  }

  visiveis.sort((a, b) => a.area - b.area);

  const alvo = visiveis[0]?.candidato;

  for (const candidato of visiveis.slice(1)) {
    await candidato.candidato.dispose().catch(() => {});
  }

  if (!alvo) return false;

  try {
    await alvo.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  } finally {
    await alvo.dispose().catch(() => {});
  }
}

async function screenshot(page, nome) {
  if (!page || page.isClosed()) return null;

  try {
    const dir = path.resolve('./logs/screenshots');
    await fs.ensureDir(dir);

    const arquivo = path.join(dir, `${nome}_${Date.now()}.png`);

    await page.screenshot({
      path: arquivo,
      fullPage: false,
    });

    logger.debug(`📸 Screenshot: ${arquivo}`);
    return arquivo;
  } catch (error) {
    logger.debug(`Não foi possível capturar screenshot: ${error.message}`);
    return null;
  }
}

class FacebookPoster {
  constructor() {
    this.browser = null;
    this.page = null;
    this.logado = false;
    this.checkpointAvisado = false;
  }

  _navegadorDisponivel() {
    return Boolean(
      this.browser &&
      this.browser.isConnected() &&
      this.page &&
      !this.page.isClosed()
    );
  }

  async iniciar() {
    logger.info('🚀 Iniciando navegador...');

    await fs.ensureDir(config.puppeteer.userDataDir);

    const candidatos = config.puppeteer.executablePaths?.length
      ? config.puppeteer.executablePaths
      : [config.puppeteer.executablePath];

    let ultimoErro = null;
    let tentativa = 0;

    for (const executablePath of candidatos) {
      for (const pipe of [false, true]) {
        try {
          logger.info(
            `🧭 Abrindo navegador: ${executablePath || 'padrão do Puppeteer'}${pipe ? ' (modo pipe)' : ''}`
          );

          this.browser = await puppeteer.launch({
            headless: config.puppeteer.headless,
            executablePath,
            userDataDir: config.puppeteer.userDataDir,
            args: config.puppeteer.args,
            defaultViewport: config.puppeteer.defaultViewport,
            pipe,
            dumpio: tentativa > 0,
          });

          break;
        } catch (error) {
          ultimoErro = error;
          tentativa += 1;

          const detalhe = String(error.message)
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .slice(0, 6)
            .join(' | ')
            .slice(0, 700);

          logger.warn(
            `⚠️ Não abriu com ${executablePath || 'o navegador padrão'}${pipe ? ' (pipe)' : ''}: ${detalhe}`
          );
        }
      }

      if (this.browser) break;
    }

    if (!this.browser) {
      throw new Error(
        `Não foi possível abrir o Chrome/Edge. ${
          candidatos.length
            ? ''
            : 'Nenhum navegador encontrado: instale o Google Chrome. '
        }Último erro: ${String(ultimoErro?.message || 'desconhecido').slice(0, 300)}`
      );
    }

    const abertas = await this.browser.pages();

    this.page =
      abertas.find(aba => aba.url() === 'about:blank') ||
      await this.browser.newPage();

    await this.page.bringToFront().catch(() => {});

    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    await this.page.emulateTimezone('America/Sao_Paulo');

    await this.page.setRequestInterception(true);

    this.page.on('request', req => {
      try {
        if (req.isInterceptResolutionHandled?.()) return;

        const tipo = req.resourceType();

        if (['media', 'font'].includes(tipo)) {
          req.abort().catch(() => {});
        } else {
          req.continue().catch(() => {});
        }
      } catch {
        // Ignora requisições que já foram encerradas.
      }
    });

    this.browser.on('disconnected', () => {
      logger.warn('⚠️ Navegador desconectado.');
    });

    logger.info('✅ Navegador iniciado');
  }

  async verificarLogin() {
    if (!this._navegadorDisponivel()) {
      throw new Error('Navegador não está disponível.');
    }

    logger.info('🔐 Verificando sessão do Facebook...');

    await this.page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await sleep(2000, 3000);

    const urlAtual = this.page.url();
    const checkpoint = /checkpoint|two_step|challenge/i.test(urlAtual);
    const temLogin = await this.page.$('input[name="email"]');

    if (checkpoint) {
      logger.warn('⚠️ Facebook solicitou uma verificação de segurança.');
      await this._aguardarLoginManual(10 * 60 * 1000);
      return;
    }

    if (temLogin || urlAtual.includes('/login')) {
      logger.info('📧 Sessão expirada — fazendo login...');
      await this._fazerLogin();
    } else {
      logger.info('✅ Sessão ativa — já logado');
      this.logado = true;
    }
  }

  async _fazerLogin() {
    if (!this._navegadorDisponivel()) {
      throw new Error('Navegador não iniciado.');
    }

    await this.page.goto('https://www.facebook.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });

    return this._aguardarLoginManual(10 * 60 * 1000);
  }

  async _fecharCookieConsent() {
    const textosBotao = [
      'Aceitar todos os cookies',
      'Aceitar todos',
      'Allow all cookies',
      'Accept all',
    ];

    for (const texto of textosBotao) {
      try {
        const [btn] = await this.page.$x(
          `//button[contains(., "${texto}")]`
        );

        if (btn) {
          await btn.click();
          await btn.dispose().catch(() => {});
          await sleep(800, 1200);
          return;
        }
      } catch {
        continue;
      }
    }
  }

  // ============================================================
  // POSTAGEM PRINCIPAL
  // ============================================================

  async postarImovel(imovel, imagensLocais, options = {}) {
    const contaId = config.facebook.contaAtiva || 1;
    const conta = config.facebook.contas[contaId] || {};

    config.facebook.whatsapp = conta.whatsapp || '';
    config.facebook.creci = conta.creci || '';

    const substituirContato = texto =>
      (texto || '').replace(/\{(whatsapp|creci)\}/gi, (_, campo) =>
        campo.toLowerCase() === 'whatsapp'
          ? config.facebook.whatsapp
          : config.facebook.creci
      );

    const imovelDaConta = {
      ...imovel,
      titulo: substituirContato(imovel.titulo),
      etiquetas: substituirContato(imovel.etiquetas),
    };

    logger.info(`📦 Postando: ${imovelDaConta.titulo}`);
    logger.info(`   Conta: ${conta.nome || contaId}`);
    logger.info(`   Etiquetas: "${imovelDaConta.etiquetas || '(vazio)'}"`);
    logger.info(`   Imagens: ${imagensLocais.length} arquivo(s)`);

    try {
      if (!this._navegadorDisponivel()) {
        throw new Error('Navegador ou página indisponível antes da postagem.');
      }

      logger.info(
        `🌐 Abrindo formulário do Marketplace: ${config.facebook.urlMarketplace}`
      );

      await this.page.goto(config.facebook.urlMarketplace, {
        waitUntil: 'load',
        timeout: config.puppeteer.timeout,
      });

      await sleep(3000, 5000);

      const currentPath = new URL(this.page.url()).pathname;

      logger.info(`📍 Página aberta após login: ${currentPath}`);

      if (!currentPath.includes('/marketplace/create/item')) {
        await screenshot(this.page, 'marketplace-formulario-redirecionado');

        throw new Error(
          `Facebook redirecionou o formulário de postagem para "${currentPath}". Verifique a sessão da conta e tente novamente.`
        );
      }

      // 1. IMAGENS
      if (imagensLocais.length > 0) {
        await this._uploadImagens(imagensLocais);
        await sleep(2000, 3000);
        await this._fecharDialogErro();
      }

      // 2. TÍTULO
      await this._preencherTitulo(imovelDaConta.titulo);

      // 3. PREÇO
      await this._preencherPreco(imovel.preco);

      // 4. CATEGORIA
      await this._selecionarCategoriaMoveis();

      // 5. CONDIÇÃO
      await this._selecionarCondicaoNovo();

      // 6. DESCRIÇÃO
      await this._preencherDescricao(imovelDaConta);

      // 7. ETIQUETAS
      await this._adicionarEtiquetas(imovelDaConta.etiquetas);

      // 8. AVANÇAR
      if (!await this._clicarAvancar()) {
        throw new Error(
          'O Facebook não avançou para a etapa de publicação.'
        );
      }

      // 9. GRUPOS + PUBLICAR
      const link = await this._publicar(
        options,
        imovelDaConta.titulo
      );

      logger.info(`✅ Postado: ${imovel.titulo} → ${link}`);

      return {
        sucesso: true,
        link,
      };
    } catch (err) {
      await screenshot(
        this.page,
        `erro-${imovel.id || 'sem-id'}`
      );

      logger.error(`❌ Erro ao postar: ${err.message}`);

      return {
        sucesso: false,
        erro: err.message,
      };
    }
  }

  // ============================================================
  // 1. UPLOAD DE IMAGENS
  // ============================================================

  async _uploadImagens(arquivos) {
    logger.info(`🖼️ Enviando ${arquivos.length} imagem(ns)...`);

    const existentes = [];

    for (const arq of arquivos) {
      if (await fs.pathExists(arq)) {
        existentes.push(arq);
        logger.debug(`  ✅ Existe: ${path.basename(arq)}`);
      } else {
        logger.warn(`  ⚠️ Não encontrado: ${arq}`);
      }
    }

    if (existentes.length === 0) {
      logger.warn('⚠️ Nenhuma imagem válida para upload');
      return;
    }

    let inputFile = await this.page.$('input[type="file"]');

    if (!inputFile) {
      await clicarPorTexto(
        this.page,
        'Adicionar fotos',
        5000
      ).catch(() => {});

      await sleep(1000, 1500);

      inputFile = await this.page.$('input[type="file"]');
    }

    if (!inputFile) {
      logger.warn('⚠️ Input de arquivo não encontrado na página');
      return;
    }

    const limite = existentes.slice(0, 10);

    await inputFile.uploadFile(...limite);
    await inputFile.dispose().catch(() => {});

    await sleep(4000, 6000);

    logger.info(`✅ ${limite.length} imagem(ns) enviada(s)`);
  }

  // ============================================================
  // 2. TÍTULO
  // ============================================================

  async _preencherTitulo(titulo) {
    const ok = await this.page.evaluate(valor => {
      const campo =
        document.querySelector('input[name="title"]') ||
        Array.from(
          document.querySelectorAll(
            'input[type="text"], input:not([type])'
          )
        ).find(el => el.offsetParent !== null);

      if (!campo) return false;

      campo.focus();
      campo.click();

      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;

      setter.call(campo, valor);

      campo.dispatchEvent(
        new Event('input', { bubbles: true })
      );

      campo.dispatchEvent(
        new Event('change', { bubbles: true })
      );

      campo.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true })
      );

      return true;
    }, titulo);

    logger.info(`  ${ok ? '✅' : '⚠️'} Título: ${ok ? 'OK' : 'FALHOU'}`);

    if (!ok) {
      await screenshot(this.page, 'marketplace-campo-titulo-ausente');

      throw new Error(
        `Campo de título do anúncio não encontrado em "${new URL(this.page.url()).pathname}".`
      );
    }

    await sleep(500, 800);
  }

  // ============================================================
  // 3. PREÇO
  // ============================================================

  async _preencherPreco(preco) {
    const precoLimpo = String(preco).replace(/[^0-9]/g, '');

    const ok = await this.page.evaluate(valor => {
      const todos = Array.from(
        document.querySelectorAll(
          'input[type="text"], input:not([type]), input[type="number"]'
        )
      ).filter(el => el.offsetParent !== null);

      const campo =
        document.querySelector('input[name="price"]') ||
        todos[1];

      if (!campo) return false;

      campo.focus();
      campo.click();

      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;

      setter.call(campo, valor);

      campo.dispatchEvent(
        new Event('input', { bubbles: true })
      );

      campo.dispatchEvent(
        new Event('change', { bubbles: true })
      );

      campo.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true })
      );

      return true;
    }, precoLimpo);

    logger.info(`  ${ok ? '✅' : '⚠️'} Preço: ${ok ? 'OK' : 'FALHOU'}`);

    if (!ok) {
      throw new Error('Campo de preço do anúncio não encontrado.');
    }

    await sleep(500, 800);
  }

  // ============================================================
  // 4. CATEGORIA
  // ============================================================

  async _selecionarCategoriaMoveis() {
    const category = 'Móveis';

    logger.info(`📂 Selecionando Categoria: ${category}...`);

    const abriu = await clicarTextoExato(
      this.page,
      'Categoria'
    );

    if (!abriu) {
      await screenshot(
        this.page,
        'categoria-controle-nao-encontrado'
      );

      throw new Error(
        'Controle de Categoria não encontrado no formulário do Marketplace.'
      );
    }

    await sleep(700, 1000);

    const selecionou = await clicarTextoExato(
      this.page,
      category
    );

    if (!selecionou) {
      const visibleOptions = await this.page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[role="option"], [role="menuitem"], li, button, [role="button"]'
          )
        )
          .filter(
            element =>
              element instanceof HTMLElement &&
              element.getClientRects().length > 0
          )
          .map(element =>
            (element.innerText || element.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(label => label && label.length < 100)
          .slice(0, 30)
      );

      logger.warn(
        `  ⚠️ Opção "${category}" não encontrada. Opções visíveis: ${visibleOptions.join(' | ') || '(nenhuma)'}`
      );

      await screenshot(this.page, 'categoria-nao-encontrada');

      throw new Error(
        `Opção de categoria "${category}" não encontrada. Verifique a lista de opções visíveis no log.`
      );
    }

    await sleep(700, 1000);

    const selectedCategory = await this.page.evaluate(() => {
      const visible = element =>
        element instanceof HTMLElement &&
        element.getClientRects().length > 0;

      const controls = Array.from(
        document.querySelectorAll(
          'button, [role="button"], [role="combobox"]'
        )
      )
        .filter(visible)
        .map(element =>
          (
            element.innerText ||
            element.getAttribute('aria-label') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
        );

      return (
        controls.find(label =>
          label.toLocaleLowerCase('pt-BR').includes('categoria')
        ) || ''
      );
    });

    if (
      !selectedCategory
        .toLocaleLowerCase('pt-BR')
        .includes(category.toLocaleLowerCase('pt-BR'))
    ) {
      await screenshot(this.page, 'categoria-nao-confirmada');

      throw new Error(
        `O clique na opção "${category}" não foi confirmado pelo formulário (campo atual: "${selectedCategory || 'não identificado'}").`
      );
    }

    await this.page.keyboard.press('Escape');

    logger.info(`✅ Categoria ${category} selecionada`);
  }

  // ============================================================
  // 5. CONDIÇÃO
  // ============================================================

  async _selecionarCondicaoNovo() {
    logger.info('🏷️ Selecionando Condição: Novo...');

    await sleep(800, 1200);

    await this.page.evaluate(() => window.scrollBy(0, 300));

    await sleep(400);

    const clicou = await clicarTextoExato(
      this.page,
      'Condição'
    );

    if (!clicou) {
      await screenshot(this.page, 'condicao-nao-encontrada');

      throw new Error(
        'Campo Condição não encontrado no formulário do Marketplace.'
      );
    }

    logger.info('  ✅ Campo Condição aberto');

    await sleep(1200, 1800);

    const novoOk = await clicarTextoExato(
      this.page,
      'Novo'
    );

    if (!novoOk) {
      await screenshot(this.page, 'condicao-novo-nao-encontrada');

      throw new Error(
        'Opção "Novo" não encontrada no campo Condição.'
      );
    }

    logger.info('  ✅ Condição NOVO selecionada');

    await sleep(1000, 1500);

    const selectedCondition = await this.page.evaluate(() => {
      const text = document.body.innerText || '';
      return /Condição\s+Novo/i.test(text);
    });

    if (!selectedCondition) {
      await screenshot(this.page, 'condicao-nao-confirmada');

      throw new Error(
        'A seleção da condição "Novo" não foi confirmada na prévia do anúncio.'
      );
    }

    await this.page.keyboard.press('Escape');
  }

  // ============================================================
  // 6. DESCRIÇÃO
  // ============================================================

  async _preencherDescricao(imovel) {
    const descricao = this._montarDescricao(imovel);

    const temCampoDescricao = async () =>
      this.page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            'textarea, [contenteditable="true"][aria-label*="descrição" i], [role="textbox"][aria-label*="descrição" i]'
          )
        ).some(
          element =>
            element instanceof HTMLElement &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden'
        )
      );

    if (!await temCampoDescricao()) {
      logger.info(
        '  Abrindo seção Mais detalhes para localizar a descrição...'
      );

      await this.page.keyboard.press('Escape');

      const abriuMaisDetalhes = await clicarTextoExato(
        this.page,
        'Mais detalhes'
      );

      if (!abriuMaisDetalhes) {
        await screenshot(
          this.page,
          'mais-detalhes-nao-encontrado'
        );

        throw new Error(
          'Seção "Mais detalhes" não encontrada para abrir o campo de descrição.'
        );
      }

      await sleep(700, 1000);

      await this.page.evaluate(() => {
        const panels = Array.from(
          document.querySelectorAll('*')
        )
          .filter(element => {
            if (!(element instanceof HTMLElement)) return false;

            const rect = element.getBoundingClientRect();

            return (
              rect.width >= 250 &&
              rect.width <= 500 &&
              rect.height >= 300 &&
              rect.left >= 0 &&
              rect.left < window.innerWidth * 0.4 &&
              element.scrollHeight > element.clientHeight + 20
            );
          })
          .sort(
            (left, right) =>
              left.getBoundingClientRect().width -
              right.getBoundingClientRect().width
          );

        const panel = panels[0];

        if (panel) {
          panel.scrollTop = panel.scrollHeight;
        }
      });

      await sleep(500, 800);
    }

    const ok = await this.page.evaluate(texto => {
      const visible = element =>
        element instanceof HTMLElement &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden';

      const campo =
        Array.from(
          document.querySelectorAll(
            'textarea[name="description"], textarea[aria-label*="descrição" i]'
          )
        ).find(visible) ||
        Array.from(
          document.querySelectorAll('textarea')
        ).find(visible) ||
        Array.from(
          document.querySelectorAll(
            '[contenteditable="true"][aria-label*="descrição" i], [role="textbox"][aria-label*="descrição" i]'
          )
        ).find(visible);

      if (!campo) return false;

      campo.focus();
      campo.click();

      if (
        campo instanceof HTMLTextAreaElement ||
        campo instanceof HTMLInputElement
      ) {
        const prototype =
          campo instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;

        const setter = Object.getOwnPropertyDescriptor(
          prototype,
          'value'
        )?.set;

        if (!setter) return false;

        setter.call(campo, texto);
      } else {
        campo.textContent = texto;
      }

      campo.dispatchEvent(
        new Event('input', { bubbles: true })
      );

      campo.dispatchEvent(
        new Event('change', { bubbles: true })
      );

      return true;
    }, descricao);

    logger.info(
      `  ${ok ? '✅' : '⚠️'} Descrição: ${ok ? 'OK' : 'FALHOU'}`
    );

    if (!ok) {
      await screenshot(this.page, 'descricao-nao-encontrada');

      throw new Error(
        'Campo de descrição não encontrado após abrir "Mais detalhes".'
      );
    }

    await sleep(800, 1200);
  }

  // ============================================================
  // 7. ETIQUETAS
  // ============================================================

  async _adicionarEtiquetas(etiquetasString) {
    logger.info(
      `🏷️ Etiquetas recebidas: "${etiquetasString || '(vazio)'}"`
    );

    if (!etiquetasString || !etiquetasString.trim()) {
      logger.warn('  ⚠️ Nenhuma etiqueta cadastrada — pulando');
      return;
    }

    const etiquetas = etiquetasString
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .slice(0, 20);

    logger.info(
      `  → ${etiquetas.length} etiqueta(s) para adicionar`
    );

    await this.page.evaluate(() => window.scrollBy(0, 800));

    await sleep(800, 1200);

    let seletorEtiqueta = await this.page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input')
      );

      const campo = inputs.find(el =>
        el.offsetParent !== null && (
          (el.placeholder || '').toLowerCase().includes('etiqueta') ||
          (el.getAttribute('aria-label') || '').toLowerCase().includes('etiqueta') ||
          (el.getAttribute('aria-label') || '').toLowerCase().includes('tag')
        )
      );

      if (!campo) return null;
      if (campo.id) return `#${campo.id}`;
      if (campo.name) return `input[name="${campo.name}"]`;

      return 'FOUND_NO_ID';
    });

    if (!seletorEtiqueta) {
      logger.info(
        '  Tentando clicar pelo label "Etiquetas de produto"...'
      );

      const clicouLabel = await clicarPorTexto(
        this.page,
        'Etiquetas de produto',
        4000
      );

      if (clicouLabel) {
        await sleep(500);

        seletorEtiqueta = 'CLICKED_LABEL';

        logger.info(
          '  ✅ Campo etiquetas ativado pelo label'
        );
      } else {
        logger.warn(
          '  ⚠️ Campo etiquetas não encontrado — pulando'
        );

        return;
      }
    }

    let adicionadas = 0;

    for (const tag of etiquetas) {
      try {
        if (
          seletorEtiqueta !== 'FOUND_NO_ID' &&
          seletorEtiqueta !== 'CLICKED_LABEL'
        ) {
          await this.page.click(seletorEtiqueta).catch(() => {});
          await sleep(100, 150);
        }

        await this.page.keyboard.type(tag, { delay: 12 });

        await sleep(120, 200);

        await this.page.keyboard.press('Enter');

        await sleep(180, 280);

        adicionadas++;
      } catch (err) {
        logger.debug(
          `  Tag "${tag}" ignorada: ${err.message}`
        );
      }
    }

    logger.info(
      `✅ ${adicionadas}/${etiquetas.length} etiqueta(s) adicionadas`
    );

    await sleep(500, 800);
  }

  // ============================================================
  // 8. AVANÇAR
  // ============================================================

  async _clicarAvancar() {
    logger.info('⏭️ Clicando em Avançar...');

    const textos = [
      'Avançar',
      'Next',
      'Continue',
    ];

    for (const texto of textos) {
      if (await clicarPorTexto(this.page, texto, 3000)) {
        logger.info(`  ✅ "${texto}" clicado`);

        await sleep(2500, 4000);

        return true;
      }
    }

    logger.warn('  ⚠️ Botão Avançar não encontrado');

    return false;
  }

  // ============================================================
  // 9. PUBLICAR
  // ============================================================

  async _publicar(options = {}, tituloEsperado = '') {
    logger.info('🚀 Publicando...');

    await sleep(2000, 3000);

    if (options.publicarEmGrupos !== false) {
      await this._selecionarGrupos();
    }

    const botao = await this._encontrarBotaoPostar();

    if (!botao) {
      await screenshot(
        this.page,
        'botao-postar-nao-encontrado'
      );

      const botoes = await this.page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            'button, [role="button"]'
          )
        )
          .filter(element => element.offsetParent !== null)
          .map(element =>
            (
              element.innerText ||
              element.getAttribute('aria-label') ||
              ''
            ).trim()
          )
          .filter(Boolean)
          .slice(-20)
      );

      throw new Error(
        `Botão "Postar" não encontrado ou desabilitado. Botões visíveis: ${botoes.join(' | ') || '(nenhum)'}`
      );
    }

    const knownItemIds = await this.page.evaluate(() => {
      const urls = [
        window.location.href,
        ...Array.from(
          document.querySelectorAll('a[href]')
        ).map(anchor => anchor.href),
      ];

      return urls
        .map(href =>
          href.match(/\/marketplace\/item\/(\d+)/)?.[1]
        )
        .filter(Boolean);
    });

    const urlAntesDaPublicacao = this.page.url();

    const textoAntesDaPublicacao = await this.page.evaluate(
      () => document.body.innerText || ''
    );

    // O Facebook recria a tela depois de marcar os grupos, e um botão obtido antes disso
    // fica inválido ("disposed"). Por isso o botão é buscado de novo logo antes de cada clique.
    await botao.dispose().catch(() => {});
    let clicou = false;
    let ultimoErroClique = null;

    for (let tentativa = 1; tentativa <= 4 && !clicou; tentativa++) {
      const alvo = await this._encontrarBotaoPostar();

      if (!alvo) {
        if (!this.page.url().includes('/marketplace/create/item')) {
          clicou = true;
          break;
        }
        await sleep(1000, 1500);
        continue;
      }

      try {
        await alvo.click();
        clicou = true;
      } catch (error) {
        ultimoErroClique = error;
        logger.warn(`  ⚠️ Clique em Postar falhou (tentativa ${tentativa}/4): ${error.message}`);
        // Se a tela já saiu do formulário, o clique chegou a funcionar.
        if (!this.page.url().includes('/marketplace/create/item')) clicou = true;
        else await sleep(1500, 2500);
      } finally {
        await alvo.dispose().catch(() => {});
      }
    }

    if (!clicou) {
      throw ultimoErroClique || new Error('Não foi possível clicar no botão Postar.');
    }

    logger.info('  ✅ Botão Postar clicado');

    let resultado = {
      link: '',
      confirmado: false,
      emAnalise: false,
    };

    const prazo = Date.now() + 30000;

    while (
      Date.now() < prazo &&
      !resultado.confirmado &&
      !resultado.link
    ) {
      await sleep(1000);

      if (!this._navegadorDisponivel()) {
        throw new Error(
          'O navegador foi fechado durante a confirmação da publicação.'
        );
      }

      resultado = await this.page.evaluate(
        ({
          knownIds,
          urlAnterior,
          textoAnterior,
          titulo,
        }) => {
          const currentHref = window.location.href;
          const currentUrl = new URL(currentHref);
          const previousUrl = new URL(urlAnterior);

          const currentItemId = currentHref.match(
            /\/marketplace\/item\/(\d+)/
          )?.[1];

          const currentItemIsNew =
            currentItemId &&
            !knownIds.includes(currentItemId);

          const texto = document.body.innerText || '';

          const normalize = value =>
            String(value || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLocaleLowerCase('pt-BR');

          const normalizedText = normalize(texto);
          const normalizedPreviousText = normalize(textoAnterior);

          const confirmationPattern =
            /anuncio (foi )?(publicado|esta no ar)|listing (is )?(published|live)|compartilhado no grupo|publicado no grupo/i;

          const confirmedByNewMessage =
            confirmationPattern.test(normalizedText) &&
            !confirmationPattern.test(normalizedPreviousText);

          const tituloEncontrado =
            Boolean(titulo) &&
            normalizedText.includes(normalize(titulo));

          const emAnalise =
            /(?:classificado|anuncio).{0,100}esta sendo analisado|under review|being reviewed/i.test(
              normalizedText
            );

          const saiuDoFormulario =
            currentUrl.href !== previousUrl.href &&
            !currentUrl.pathname.includes(
              '/marketplace/create/item'
            );

          const confirmadoNaLista =
            saiuDoFormulario &&
            tituloEncontrado &&
            emAnalise;

          let linkId = currentItemIsNew
            ? currentItemId
            : undefined;

          if (!linkId && confirmadoNaLista && titulo) {
            const anchors = Array.from(
              document.querySelectorAll('a[href]')
            ).filter(anchor => anchor.offsetParent !== null);

            const tituloAnchor = anchors.find(anchor =>
              normalize(
                anchor.innerText || anchor.textContent
              ).includes(normalize(titulo))
            );

            const href = tituloAnchor?.href;

            linkId = href?.match(
              /\/marketplace\/item\/(\d+)/
            )?.[1];
          }

          const itemId = currentItemIsNew
            ? currentItemId
            : linkId;

          return {
            link: itemId
              ? `https://www.facebook.com/marketplace/item/${itemId}/`
              : '',
            confirmado:
              confirmedByNewMessage ||
              Boolean(currentItemIsNew) ||
              confirmadoNaLista,
            emAnalise: confirmadoNaLista,
          };
        },
        {
          knownIds: knownItemIds,
          urlAnterior: urlAntesDaPublicacao,
          textoAnterior: textoAntesDaPublicacao,
          titulo: tituloEsperado,
        }
      );
    }

    if (!resultado.confirmado && !resultado.link) {
      throw new Error(
        'Não foi possível confirmar a publicação. Verifique o Marketplace antes de reenfileirar para evitar duplicidade.'
      );
    }

    if (resultado.emAnalise) {
      logger.info(
        '✅ Anúncio confirmado em "Seus classificados"; está sendo analisado pelo Facebook.'
      );
    }

    if (resultado.confirmado && !resultado.link) {
      logger.warn(
        '  ⚠️ Publicação confirmada, mas não encontrei um link novo para o anúncio; não será associado nenhum link antigo.'
      );
    }

    return resultado.link;
  }

  
async _encontrarBotaoPostar() {
  const prazo = Date.now() + 10000;

  while (Date.now() < prazo) {
    const candidatos = await this.page.$$(
      'button, [role="button"]'
    );

    let encontrado = null;

    for (const candidato of candidatos) {
      try {
        const dados = await candidato.evaluate(element => {
          const texto = (
            element.innerText ||
            element.getAttribute('aria-label') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();

          return {
            texto,
            visivel: element.offsetParent !== null,
            desabilitado:
              element.hasAttribute('disabled') ||
              element.getAttribute('aria-disabled') === 'true'
          };
        });

        if (
          dados.visivel &&
          !dados.desabilitado &&
          ['postar', 'publicar'].includes(dados.texto)
        ) {
          encontrado = candidato;
          break;
        }
      } catch {
        await candidato.dispose().catch(() => {});
      }

      if (encontrado !== candidato) {
        await candidato.dispose().catch(() => {});
      }
    }

    if (encontrado) {
      try {
        await encontrado.evaluate(element => {
          element.scrollIntoView({
            block: 'center',
            inline: 'center'
          });
        });

        return encontrado;
      } catch {
        await encontrado.dispose().catch(() => {});
      }
    }

    await sleep(500);
  }

  return null;
}


  // ============================================================
  // GRUPOS
  // ============================================================

  async _selecionarGrupos() {
    logger.info('👥 Selecionando os 20 maiores grupos...');

    await sleep(1500, 2500);

    const naTelaGrupos = await this.page.evaluate(() =>
      document.body.innerText.includes(
        'Anunciar nos seus grupos'
      ) ||
      document.body.innerText.includes('seus grupos')
    );

    if (!naTelaGrupos) {
      logger.info(
        '  ℹ️ Tela de grupos não detectada — pulando'
      );

      return;
    }

    await this.page.evaluate(() => {
      const painel =
        document.querySelector('[role="dialog"]') ||
        document.body;

      painel.scrollTop = 9999;
    });

    await sleep(1000, 1500);

    const resultado = await this.page.evaluate(() => {
      function parseMembros(texto) {
        if (!texto) return 0;

        const match = texto.match(/([\d,.]+)\s*(mil)?/i);

        if (!match) return 0;

        let num = parseFloat(
          match[1].replace(',', '.')
        );

        if (match[2]) num *= 1000;

        return Math.round(num);
      }

      const grupos = [];

      const checkboxes = Array.from(
        document.querySelectorAll(
          '[role="checkbox"][aria-checked="false"], input[type="checkbox"]:not(:checked)'
        )
      ).filter(el => el.offsetParent !== null);

      for (const checkbox of checkboxes) {
        let container = checkbox;

        for (let i = 0; i < 6; i++) {
          container = container.parentElement;

          if (!container) break;

          const texto = container.innerText || '';

          if (texto.includes('membros')) {
            const membros = parseMembros(texto);
            const nome =
              texto.split('\n')[0]?.trim() || 'Grupo';

            grupos.push({
              checkbox,
              membros,
              nome,
            });

            break;
          }
        }
      }

      grupos.sort(
        (a, b) => b.membros - a.membros
      );

      const selecionados = [];

      for (const grupo of grupos.slice(0, 20)) {
        try {
          grupo.checkbox.click();

          selecionados.push({
            nome: grupo.nome,
            membros: grupo.membros,
          });
        } catch {
          // Ignora grupo que não pôde ser selecionado.
        }
      }

      return selecionados;
    });

    if (resultado && resultado.length > 0) {
      logger.info(
        `✅ ${resultado.length} grupos selecionados (por tamanho):`
      );

      resultado.forEach((grupo, i) => {
        const membros = grupo.membros >= 1000
          ? `${(grupo.membros / 1000).toFixed(1)}k`
          : grupo.membros;

        logger.info(
          `   ${i + 1}. ${grupo.nome} — ${membros} membros`
        );
      });

      await sleep(1000, 1500);
    } else {
      logger.warn(
        '  ⚠️ Nenhum grupo encontrado para selecionar'
      );
    }
  }

  // ============================================================
  // EDITOR DE PREÇOS
  // ============================================================

  async executarEditorPreco(valorAlvo = 10) {
    logger.info(
      `💰 Iniciando editor de preços para valor alvo: R$ ${valorAlvo}`
    );

    const PriceEditor = require('./priceEditor');
    const editor = new PriceEditor(this.page);

    return editor.reduzirPrecos(valorAlvo);
  }

  // ============================================================
  // FECHAR DIALOG DE ERRO
  // ============================================================

  async _fecharDialogErro() {
    try {
      const temDialog = await this.page.evaluate(() =>
        document.body.innerText.includes('Opa!') ||
        document.body.innerText.includes('Ocorreu um erro')
      );

      if (!temDialog) return;

      logger.warn('⚠️ Dialog de erro — fechando...');

      const fechou = await clicarPorTexto(
        this.page,
        'Fechar',
        3000
      );

      if (fechou) {
        await sleep(1000, 1500);
      } else {
        await this.page.keyboard.press('Escape');
        await sleep(500);
      }
    } catch {
      // O dialog pode desaparecer sozinho.
    }
  }

  // ============================================================
  // DESCRIÇÃO FORMATADA
  // ============================================================

  _montarDescricao(imovel) {
    const descricaoOriginal = imovel.descricao || '';

    const usaWhatsapp = /\{whatsapp\}/i.test(
      descricaoOriginal
    );

    const usaCreci = /\{creci\}/i.test(
      descricaoOriginal
    );

    const marcadorWhatsapp = '\uE000WHATSAPP\uE001';
    const marcadorCreci = '\uE000CRECI\uE001';

    let desc = descricaoOriginal
      .replace(/\{whatsapp\}/gi, marcadorWhatsapp)
      .replace(/\{creci\}/gi, marcadorCreci)
      .replace(
        /\n*📲(?![^\n]*\uE000WHATSAPP\uE001)[^\n]*/gi,
        ''
      )
      .replace(
        /\n*Mais informações\n(?![^\n]*\uE000WHATSAPP\uE001)[^\n]*/gi,
        ''
      )
      .replace(
        /\n*✒️?\s*CRECI(?![^\n]*\uE000CRECI\uE001)[^\n]*/gi,
        ''
      )
      .replace(/\n{3,}/g, '\n\n')
      .replace(
        /\uE000WHATSAPP\uE001/gi,
        config.facebook.whatsapp || ''
      )
      .replace(
        /\uE000CRECI\uE001/gi,
        config.facebook.creci || ''
      )
      .replace(/^[ \t]*📲[ \t]*$/gim, '')
      .replace(/^[ \t]*Mais informações[ \t]*$/gim, '')
      .replace(/^[ \t]*✒️?[ \t]*CRECI[ \t]*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const normalizar = texto =>
      texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR');

    const descricaoNormalizada = normalizar(desc);

    const partes = desc ? [desc] : [];
    const detalhes = [];

    if (
      imovel.localizacao &&
      !descricaoNormalizada.includes(
        normalizar(imovel.localizacao)
      )
    ) {
      detalhes.push(`📍 ${imovel.localizacao}`);
    }

    if (
      imovel.quartos &&
      !new RegExp(
        `\\b${Number(imovel.quartos)}\\s*(?:quarto|quartos|dormitorio|dormitorios)\\b`
      ).test(descricaoNormalizada)
    ) {
      detalhes.push(`🛏 ${imovel.quartos} quarto(s)`);
    }

    if (
      imovel.banheiros &&
      !new RegExp(
        `\\b${Number(imovel.banheiros)}\\s*(?:banheiro|banheiros)\\b`
      ).test(descricaoNormalizada)
    ) {
      detalhes.push(`🚿 ${imovel.banheiros} banheiro(s)`);
    }

    if (
      imovel.area &&
      !new RegExp(
        `\\b${String(Number(imovel.area)).replace('.', '[.,]')}(?:[.,]0+)?\\s*(?:m²|m2|metros quadrados)`
      ).test(descricaoNormalizada)
    ) {
      detalhes.push(`📐 ${imovel.area} m²`);
    }

    if (detalhes.length > 0) {
      partes.push('\n' + detalhes.join('\n'));
    }

    const whatsapp = config.facebook.whatsapp || '';
    const creci = config.facebook.creci || '';

    if (whatsapp && !usaWhatsapp) {
      partes.push(`\nMais informações\n${whatsapp}`);
    }

    if (creci && !usaCreci) {
      partes.push(`✒️ ${creci}`);
    }

    return partes.join('\n');
  }

  // ============================================================
  // POSTAR EM MÚLTIPLAS CONTAS
  // ============================================================

  async postarMultiplasContas(
    imovel,
    imagensLocais,
    contasSelecionadas = [1],
    options = {}
  ) {
    logger.info(
      `📦 Postando em ${contasSelecionadas.length} conta(s): ${imovel.titulo}`
    );

    const resultados = [];

    for (const contaId of contasSelecionadas) {
      if (typeof logger.setAccountNumber === 'function') {
        logger.setAccountNumber(contaId);
      }

      logger.info(`  🔄 Conta ${contaId}: iniciando...`);

      let posterConta = null;

      const userDataDirOriginal =
        config.puppeteer.userDataDir;

      const headlessOriginal =
        config.puppeteer.headless;

      try {
        const conta = config.facebook.contas[contaId];

        if (!conta || !conta.email) {
          throw new Error(
            `Conta ${contaId} sem e-mail/telefone cadastrado no painel.`
          );
        }

        config.facebook.contaAtiva = contaId;
        config.facebook.whatsapp = conta.whatsapp || '';
        config.facebook.creci = conta.creci || '';
        config.facebook.email = conta.email;

        config.puppeteer.userDataDir =
          conta.userDataDir ||
          path.resolve(
            process.env.WORKER_DATA_DIR || process.cwd(),
            'chrome-profiles',
            `conta${contaId}`
          );

        // Primeira tentativa: sessão salva em modo invisível.
        config.puppeteer.headless = true;

        posterConta = new FacebookPoster();

        await posterConta.iniciar();

        let logado =
          await posterConta._verificarLoginComSessao();

        await (logado ? fbSession.marcarConectada(config.puppeteer.userDataDir) : fbSession.desmarcar(config.puppeteer.userDataDir)).catch(() => {});

        // Sem sessão válida, abre navegador visível.
        if (!logado) {
          await posterConta.fechar();

          config.puppeteer.headless = false;

          posterConta = new FacebookPoster();

          await posterConta.iniciar();

          await posterConta.page.goto(
            'https://www.facebook.com/login',
            {
              waitUntil: 'domcontentloaded',
              timeout: 40000,
            }
          );

          logger.warn(
            `🔐 CONTA ${contaId}: faça o login manualmente na janela do Facebook. O AnuncIA não solicita nem armazena sua senha.`
          );

          await posterConta._aguardarLoginManual(
            10 * 60 * 1000
          );

          await posterConta.fechar();

          // Reabre o mesmo perfil em modo invisível.
          config.puppeteer.headless = true;

          posterConta = new FacebookPoster();

          await posterConta.iniciar();

          logado =
            await posterConta._verificarLoginComSessao();

          if (logado) await fbSession.marcarConectada(config.puppeteer.userDataDir).catch(() => {});

          if (!logado) {
            throw new Error(
              `A sessão da Conta ${contaId} não foi confirmada após o login. Clique em reconectar e tente novamente.`
            );
          }
        }

        logger.info(
          `  👻 Sessão da Conta ${contaId} validada. Publicação em modo invisível.`
        );

        await posterConta.page.waitForSelector(
          'body',
          { timeout: 15000 }
        );

        await this._aguardar(1500, 2500);

        const resultado = await posterConta.postarImovel(
          imovel,
          imagensLocais,
          {
            publicarEmGrupos: options.publicarEmGrupos,
          }
        );

        const accountResult = resultado.sucesso
          ? {
              contaId,
              sucesso: true,
              link: resultado.link,
            }
          : {
              contaId,
              sucesso: false,
              erro: resultado.erro,
            };

        resultados.push(accountResult);

        if (resultado.sucesso) {
          logger.info(
            `  ✅ Conta ${contaId}: publicado com sucesso.`
          );
        } else {
          logger.warn(
            `  ❌ Conta ${contaId}: ${resultado.erro}`
          );
        }

        if (options.onAccountResult) {
          try {
            await options.onAccountResult(accountResult);
          } catch (syncError) {
            logger.error(
              `Falha ao sincronizar resultado da Conta ${contaId}: ${syncError.message}`
            );
          }
        }

        await posterConta.fechar();
        posterConta = null;

        if (
          contaId !==
          contasSelecionadas[contasSelecionadas.length - 1]
        ) {
          logger.info(
            '⏳ Aguardando antes de iniciar a próxima conta...'
          );

          await this._aguardar(30000, 45000);
        }
      } catch (err) {
        logger.error(
          `  ❌ Conta ${contaId}: erro - ${err.message}`
        );

        const accountResult = {
          contaId,
          sucesso: false,
          erro: err.message,
        };

        resultados.push(accountResult);

        if (options.onAccountResult) {
          try {
            await options.onAccountResult(accountResult);
          } catch (syncError) {
            logger.error(
              `Falha ao sincronizar resultado da Conta ${contaId}: ${syncError.message}`
            );
          }
        }

        if (posterConta) {
          await posterConta.fechar().catch(() => {});
        }
      } finally {
        config.puppeteer.userDataDir =
          userDataDirOriginal;

        config.puppeteer.headless =
          headlessOriginal;

        config.facebook.email = '';

        if (typeof logger.setAccountNumber === 'function') {
          logger.setAccountNumber(null);
        }
      }
    }

    return {
      sucesso: resultados.some(resultado => resultado.sucesso),
      resultados,
    };
  }

  // ============================================================
  // LOGIN MANUAL
  // ============================================================

  async _aguardarLoginManual(timeoutMs = 600000) {
    const inicio = Date.now();

    this.checkpointAvisado = false;

    logger.info(
      '🪟 Navegador aberto. Entre no Facebook e conclua qualquer confirmação solicitada.'
    );

    while (Date.now() - inicio < timeoutMs) {
      if (!this.browser || !this.browser.isConnected()) {
        throw new Error(
          'O navegador foi fechado ou desconectado durante o login manual. Abra novamente a conexão da conta.'
        );
      }

      if (!this.page || this.page.isClosed()) {
        throw new Error(
          'A aba do Facebook foi fechada durante o login manual. Tente conectar a conta novamente.'
        );
      }

      await this._aguardar(2000);

      try {
        const url = this.page.url();

        const checkpoint =
          /checkpoint|two_step|challenge/i.test(url);

        const cookies = await this.page.cookies(
          'https://www.facebook.com'
        );

        const temCookieUsuario = cookies.some(
          cookie =>
            cookie.name === 'c_user' &&
            cookie.value
        );

        const estaEmLogin =
          url.includes('/login') ||
          Boolean(
            await this.page.$('input[name="email"]')
          );

        if (checkpoint) {
          if (!this.checkpointAvisado) {
            logger.warn(
              '⚠️ O Facebook solicitou uma confirmação de segurança. Conclua a verificação manualmente na janela aberta.'
            );

            this.checkpointAvisado = true;
          }

          continue;
        }

        if (estaEmLogin || !temCookieUsuario) {
          continue;
        }

        // Aguarda a navegação estabilizar antes de confirmar.
        await this._aguardar(2500, 3500);

        if (!this._navegadorDisponivel()) {
          throw new Error(
            'O navegador foi fechado antes da confirmação do login.'
          );
        }

        const urlFinal = this.page.url();

        const aindaEmCheckpoint =
          /checkpoint|two_step|challenge/i.test(urlFinal);

        const aindaEmLogin =
          urlFinal.includes('/login') ||
          Boolean(
            await this.page.$('input[name="email"]')
          );

        if (aindaEmCheckpoint || aindaEmLogin) {
          continue;
        }

        const cookiesFinais = await this.page.cookies(
          'https://www.facebook.com'
        );

        const sessaoConfirmada = cookiesFinais.some(
          cookie =>
            cookie.name === 'c_user' &&
            cookie.value
        );

        if (!sessaoConfirmada) {
          continue;
        }

        logger.info(
          '✅ Login manual concluído; sessão salva no perfil local.'
        );

        this.logado = true;

        return true;
      } catch (error) {
        if (
          !this.browser ||
          !this.browser.isConnected() ||
          !this.page ||
          this.page.isClosed()
        ) {
          throw new Error(
            'A conexão com o navegador foi perdida durante o login manual. Tente conectar a conta novamente.'
          );
        }

        logger.debug(
          `Aguardando conclusão do login: ${error.message}`
        );
      }
    }

    throw new Error(
      'Tempo limite aguardando o login manual no Facebook (10 minutos). Conclua o login e as verificações de segurança antes de tentar novamente.'
    );
  }

  // ============================================================
  // VERIFICAR SESSÃO SALVA
  // ============================================================

  async _verificarLoginComSessao() {
    try {
      if (!this._navegadorDisponivel()) {
        logger.debug(
          '❌ Navegador indisponível para verificar sessão.'
        );

        return false;
      }

      logger.debug('🔍 Verificando sessão salva...');

      await this.page.goto(
        'https://www.facebook.com/',
        {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        }
      );

      await this._aguardar(3000, 4000);

      const urlAtual = this.page.url();

      logger.debug(`📍 URL atual: ${urlAtual}`);

      // Checkpoint precisa ser resolvido manualmente.
      if (
        /checkpoint|two_step|challenge/i.test(urlAtual)
      ) {
        logger.warn(
          '⚠️ Facebook pediu verificação de segurança (checkpoint). Será necessário abrir o navegador visível.'
        );

        this.logado = false;

        return false;
      }

      const estaEmLogin =
        urlAtual.includes('/login') ||
        Boolean(
          await this.page.$('input[name="email"]')
        );

      if (estaEmLogin) {
        logger.debug(
          '❌ Redirecionado para página de login.'
        );

        this.logado = false;

        return false;
      }

      const temFeed = await this.page.$('[role="feed"]');

      if (temFeed) {
        logger.debug('✅ Feed encontrado - logado!');

        this.logado = true;

        return true;
      }

      const temAvatar = await this.page.$(
        'img[alt*="Foto do perfil"]'
      );

      if (temAvatar) {
        logger.debug('✅ Avatar encontrado - logado!');

        this.logado = true;

        return true;
      }

      const temInicio = await this.page.$(
        'a[aria-label="Início"]'
      );

      if (temInicio) {
        logger.debug(
          '✅ Link Início encontrado - logado!'
        );

        this.logado = true;

        return true;
      }

      const cookies = await this.page.cookies(
        'https://www.facebook.com'
      );

      if (
        cookies.some(
          cookie =>
            cookie.name === 'c_user' &&
            cookie.value
        )
      ) {
        logger.debug(
          '✅ Cookie de sessão do Facebook encontrado.'
        );

        this.logado = true;

        return true;
      }

      logger.debug(
        '❌ Nenhum indicador de login encontrado.'
      );

      this.logado = false;

      return false;
    } catch (err) {
      logger.debug(
        `⚠️ Erro ao verificar sessão: ${err.message}`
      );

      this.logado = false;

      return false;
    }
  }

  // ============================================================
  // MÉTODO AUXILIAR DE DELAY
  // ============================================================

  async _aguardar(min, max) {
    await sleep(min, max);
  }

  // ============================================================
  // FECHAR NAVEGADOR
  // ============================================================

  async fechar() {
    const browser = this.browser;

    this.browser = null;
    this.page = null;
    this.logado = false;

    if (browser) {
      try {
        if (browser.isConnected()) {
          await browser.close();
        }

        logger.info('🔒 Navegador fechado');
      } catch (error) {
        logger.debug(
          `Navegador já estava fechado: ${error.message}`
        );
      }
    }
  }
}

module.exports = FacebookPoster;
