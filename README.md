# AnuncIA Worker 2.1

Aplicativo Windows que mantém a automação local conectada ao painel AnuncIA (https://anunciamarketplace.vercel.app). O computador do cliente executa as publicações; o painel/Supabase continua sendo a fonte dos imóveis, imagens, contas e resultados.

## Login e empresa (tenant)

- O cliente entra no app com o **mesmo e-mail e senha do painel AnuncIA**.
- O app chama `POST /api/worker/auth/login` no painel, que valida no Supabase Auth e devolve o token do usuário e o `tenantId` dele.
- O **tenant é decidido pelo servidor** a partir do token. O app só repassa o `tenantId` por compatibilidade e o servidor recusa (403) qualquer valor que não seja o do usuário.
- Não existe mais `.env`, `PANEL_WORKER_TOKEN` nem `WORKER_TENANT_ID` no app: nenhum segredo global vai dentro do instalador.
- O token de acesso fica só em memória; o refresh token fica criptografado no Windows (DPAPI, via `safeStorage`) em `%APPDATA%/AnuncIA Worker/session.bin`. "Sair da conta" apaga tudo.

## Facebook

- O painel guarda somente o identificador da conta (e-mail/telefone), nome, WhatsApp, CRECI e status. A senha do Facebook nunca passa pelo AnuncIA.
- Na primeira vez, o Worker abre o navegador visível para o cliente entrar e concluir verificações; o perfil/cookies ficam salvos localmente, separados por empresa e conta.
- Nas próximas publicações o Worker tenta reutilizar a sessão em modo invisível; se expirar ou o Facebook pedir confirmação, volta a abrir a janela. O Worker não tenta contornar verificações.
- Requer Google Chrome **ou** Microsoft Edge instalado (o Edge já vem no Windows 10/11).

## Desenvolvimento

```
npm install
npm start                    # abre o app (usa o painel de produção)
# painel local: set ANUNCIA_PANEL_URL=http://localhost:3000 (só funciona fora do instalador)
npm run build-win            # gera dist/AnuncIA-Worker-Setup-<versão>.exe
```

Veja `INSTALADOR-WINDOWS.md` para build, distribuição e as mudanças necessárias no painel (`servidor-painel/`).

## Pastas locais

Perfis do Facebook, imagens temporárias e logs ficam em `%APPDATA%/AnuncIA Worker`, fora da pasta de instalação. Não compartilhe esses perfis: contêm sessões autenticadas.
