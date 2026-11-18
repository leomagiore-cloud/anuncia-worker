# Contrato necessário para autenticação individual

O Worker atual ainda usa `PANEL_WORKER_TOKEN` e `WORKER_TENANT_ID` globais. Não distribuir essa compilação para clientes até substituir esse fluxo. O repositório do Worker não contém a implementação do backend do painel; portanto, os endpoints abaixo são uma proposta de contrato e precisam ser implementados e homologados no painel antes de ativar o login.

## Endpoints propostos

Base: `https://<dominio-do-painel>/api/desktop`

- `POST /login`: recebe `{ email, password, deviceName, deviceId, appVersion }`; valida a conta no servidor e retorna `{ accessToken, refreshToken, expiresIn, user, tenantId, permissions }`.
- `POST /refresh`: recebe `{ refreshToken, deviceId }`; rotaciona o refresh token e retorna novos tokens.
- `POST /logout`: revoga a sessão/dispositivo.
- `GET /worker/bootstrap`: retorna a configuração e os tenants autorizados para o usuário autenticado. O servidor deve derivar o tenant do token; não aceitar tenant arbitrário informado pelo cliente.

## Requisitos de segurança

- HTTPS obrigatório; senha nunca persistida no computador.
- Hash de senha forte no servidor (preferencialmente Argon2id) e proteção contra tentativas repetidas.
- Access token curto e refresh token rotativo, armazenado no cofre do sistema operacional (Windows Credential Manager/DPAPI), não em arquivo .env ou localStorage.
- Vincular sessão a um identificador aleatório por instalação; permitir revogar dispositivos no painel.
- Validar assinatura, expiração, usuário ativo, assinatura/plano e permissões em cada chamada sensível.
- Nunca colocar `PANEL_WORKER_TOKEN`, service-role key ou segredo de backend no instalador.
- O backend deve filtrar todos os dados por tenant autorizado no servidor.

## Integração pendente

A implementação do login no Electron depende da confirmação dos endpoints reais, do formato de resposta e do mecanismo de armazenamento seguro aprovado para o painel. Não criar endpoints fictícios nem considerar a autenticação pronta até a integração ponta a ponta ser testada.
