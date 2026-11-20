# Do código ao instalador do cliente

## 1. Painel (projeto Next.js/Vercel) — obrigatório antes de distribuir
O `painel.zip` atualizado acompanha este projeto. Resumo do que mudou:
- `lib/worker-auth.ts`: `authenticateWorker` valida o token de sessão do usuário e busca o tenant em `profiles`; `checkWorkerTenant` recusa (403) qualquer `tenantId` que não seja o do dono do token.
- Novas rotas `app/api/worker/auth/login` e `auth/refresh` (login com a conta do painel; exigem e-mail confirmado, identificação preenchida e termo vigente aceito).
- As rotas `credentials`, `jobs`, `results`, `commands`, `logs` e `tenants` deixaram de usar o `WORKER_API_TOKEN`.
- Depois do deploy, **apague o `WORKER_API_TOKEN` da Vercel**: ele já circulou em `.env` locais e não é mais usado.
- Instaladores antigos (2.0, com token no `.env`) deixam de funcionar; todo cliente de teste precisa instalar a 2.1.

## 2. Gerar o instalador (no Windows)
```
npm install
npm run build-win
```
Saída: `dist/AnuncIA-Worker-Setup-2.1.0.exe` (instalador NSIS, atalhos na área de trabalho e Menu Iniciar, inicia com o Windows).

## 3. Testar antes de liberar
- PC limpo (ou VM) sem Node: instalar, entrar com uma conta de teste, "Conectar Facebook", "Publicar agora".
- Duas contas de empresas diferentes: conferir que cada uma só vê as próprias contas/imóveis.
- Desligar a internet, reiniciar o app: deve mostrar "Reconectando..." e voltar sozinho.
- Senha errada, e-mail não confirmado e "Sair da conta".

## 4. Distribuição
- O `.exe` não contém segredos, então pode ficar em GitHub Releases ou num botão "Baixar para Windows" no painel.
- Sem assinatura digital, o Windows SmartScreen mostra "Windows protegeu seu PC". Para eliminar o aviso é preciso certificado de code signing (EV ou Azure Trusted Signing) configurado no electron-builder.
- Atualizações automáticas (`electron-updater` + GitHub Releases) são um próximo passo; hoje o cliente reinstala a nova versão.
