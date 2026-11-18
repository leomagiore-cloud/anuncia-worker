# AnuncIA Worker 2.0

Aplicativo Windows que mantém a automação local conectada ao painel AnuncIA. O computador do usuário executa as publicações; o painel/Supabase continua sendo a fonte dos imóveis, imagens, contas e resultados.

## Fluxo de autenticação do Facebook

- O painel armazena somente o identificador da conta (e-mail/telefone), nome, WhatsApp, CRECI e status.
- O AnuncIA não solicita, recebe ou armazena a senha do Facebook.
- Na primeira publicação, o Worker abre o navegador visível para o usuário entrar e concluir eventuais verificações.
- O perfil e os cookies são salvos localmente, separados por empresa e conta.
- Nas próximas publicações, o Worker tenta reutilizar a sessão em modo headless (sem janela).
- Se a sessão expirar ou o Facebook pedir confirmação, o Worker volta a abrir o navegador visível.

## Distribuição e atualizações

O instalador Windows é gerado com `npm run build-win`. As atualizações são publicadas por GitHub Releases: crie e envie uma tag no formato `vX.Y.Z` (igual à versão em `package.json`) para disparar `.github/workflows/release.yml`. O aplicativo verifica atualizações ao iniciar, oferece baixar e permite adiar; após o download, o usuário escolhe quando instalar. O recurso só funciona em builds instaladas e publicadas em Releases.

Antes de distribuir a clientes, implemente o contrato descrito em `docs/AUTHENTICATION-CONTRACT.md`: a versão atual ainda depende de token global e tenant em `.env`.

## Configuração de teste interno

1. Instale Node.js 20 ou superior.
2. Copie `.env.example` para `.env`.
3. Preencha `PANEL_API_URL`, `PANEL_WORKER_TOKEN` e `WORKER_TENANT_ID`.
4. Execute `npm install`.
5. Execute `npm start`.

`WORKER_TENANT_ID` é o `tenant_id` da empresa em `profiles` no Supabase. O token precisa ser o mesmo `WORKER_API_TOKEN` configurado no servidor do painel.

**Atenção:** esta compilação é para teste interno. Ela ainda utiliza o token global do worker e um tenant configurado no `.env`. Não distribua este instalador a clientes: antes disso, implementaremos autenticação individual do AnuncIA no aplicativo e vínculo seguro por dispositivo, para que nenhum segredo global seja incluído no executável.

## Executar

- `npm start`: abre o aplicativo e inicia o Worker automaticamente.
- `npm run worker`: executa o worker no terminal.
- `npm run post-agora`: processa a fila imediatamente no terminal.
- `npm run testar-login`: abre o Facebook para autenticação manual de teste.
- `npm run build-win`: gera o instalador Windows em `dist/`.

O aplicativo fica na bandeja do Windows, inicia junto com o Windows e mantém o processo de fila/scheduler ativo. O computador precisa permanecer ligado, conectado à internet e sem suspensão.

## Pastas locais

Perfis do Facebook, imagens temporárias e logs são gravados em `%APPDATA%/anuncia-worker` (pasta de dados do Electron), fora da pasta de instalação. Não compartilhe esses perfis: eles contêm sessões autenticadas.

## Limitação do modo invisível

Headless é uma opção de execução, não uma garantia de que o Facebook sempre manterá a sessão. Desafios, checkpoints ou expiração podem exigir nova autenticação visível. O Worker não tenta contornar essas verificações.
