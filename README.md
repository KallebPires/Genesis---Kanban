# Genesis — Kanban

App de operações (kanban, projetos, equipe, financeiro) com backend próprio em Node.js + MongoDB — sem dependência de nenhum serviço de nuvem de terceiros.

## Rodando na VPS

1. Copie o projeto para a VPS e instale as dependências do servidor:
   ```
   cd server
   npm install
   ```
2. Configure o `.env` (copie `server/.env.example` para `server/.env` e ajuste):
   ```
   MONGODB_URI=mongodb://127.0.0.1:27017   # ou a URI do seu MongoDB
   MONGODB_DB=genesis
   JWT_SECRET=uma-string-longa-e-aleatoria
   PORT=3000
   ```
3. Crie o primeiro administrador (só precisa rodar uma vez):
   ```
   node seed-admin.js "Seu Nome" seu@email.com senhaSegura123 "Sua Função"
   ```
4. Suba o servidor:
   ```
   node index.js
   ```
   Em produção, use um gerenciador de processo como `pm2` ou um serviço `systemd` pra manter rodando e reiniciar sozinho se cair. Coloque um Nginx/Caddy na frente pra HTTPS.

O próprio servidor Node já serve o frontend (`index.html`, `app.js`, `styles.css`, `assets/`) e a API (`/api/*`) juntos, na mesma porta — não precisa de outro servidor pra arquivos estáticos.

## Como funciona o acesso

- Não existe cadastro aberto: só quem já é administrador pode adicionar gente nova (tela Equipe → "Adicionar usuário"), incluindo marcar a nova pessoa como admin também.
- O primeiro admin só pode ser criado pelo script `seed-admin.js` direto no servidor.

## Desenvolvimento local

Precisa de um MongoDB rodando localmente (ou apontar `MONGODB_URI` para um remoto). Sem backend rodando, o app não funciona — não há mais modo "só estático".
