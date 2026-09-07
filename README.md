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

## Sincronizar Issues do GitHub com o Kanban

Qualquer repositório do GitHub (de qualquer conta/organização — nada fixo no código) pode virar um projeto no Kanban, com as Issues viradas tarefas, sincronizado nos dois sentidos:

- **GitHub → Kanban**: Issues novas/atualizadas viram tarefas automaticamente (a cada `GITHUB_SYNC_MINUTES`, padrão 5 min). Labels viram etiquetas. Fechar a Issue no GitHub move a tarefa pra "Concluído"; reabrir tira de lá.
- **Kanban → GitHub**: mover uma tarefa ligada a uma Issue pra "Concluído" fecha a Issue no GitHub (e tirar de lá reabre). Comentários adicionados na tarefa viram comentários reais na Issue.

**Configurar (uma vez, no `.env` da VPS):**
```
GITHUB_TOKEN=ghp_seu_token_aqui   # Personal Access Token com escopo "repo" (classic) ou Issues read/write (fine-grained)
GITHUB_SYNC_MINUTES=5
```
Gerar o token em: https://github.com/settings/tokens

**Conectar um repositório** — não tem tela própria pra isso ainda, é feito via API (ou pelo chat, veja a seção MCP/GPT abaixo):
```
curl -X POST https://SEU-DOMINIO/api/github/repos \
  -H "Content-Type: application/json" -H "x-api-key: SUA_MCP_API_KEY" \
  -d '{"owner":"dono-do-repo","repo":"nome-do-repo"}'
```
Isso cria um projeto no Kanban com o nome do repositório e já importa as Issues existentes.

Se alguém tiver um `githubUsername` cadastrado (campo opcional no convite da Equipe) e for o assignee de uma Issue no GitHub, a tarefa já nasce atribuída a ela automaticamente.

## Controlar o Kanban pelo chat (Claude e ChatGPT)

Toda a API (`/api/*`) aceita uma chave estática além do login normal, pensada pra automações e assistentes de IA agirem em nome da equipe (aparecem no histórico como "Integração (MCP/GPT)").

**1. Gere a chave e configure no `.env` da VPS:**
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Cole o resultado em `MCP_API_KEY=` no `.env` e reinicie o servidor. Guarde essa chave — quem tiver ela consegue mexer no Kanban inteiro (criar/mover/apagar tarefas, convidar gente, conectar repositórios).

**2. Para o Claude (MCP nativo):**

O servidor MCP fica em `mcp/` e roda localmente na máquina de quem for usar (Claude Desktop ou Claude Code chamam ele automaticamente). Ele não guarda nada — só repassa chamadas pra API da VPS.

```
cd mcp
npm install
```

No `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "genesis-kanban": {
      "command": "node",
      "args": ["/caminho/completo/para/Kanban-Genesis/mcp/index.js"],
      "env": {
        "GENESIS_API_URL": "https://SEU-DOMINIO",
        "GENESIS_API_KEY": "a-mesma-chave-do-MCP_API_KEY"
      }
    }
  }
}
```
Reinicie o Claude Desktop. As ferramentas (`list_tasks`, `create_task`, `update_task`, `connect_github_repo`, `sync_github`, etc.) aparecem disponíveis na conversa.

**3. Para o ChatGPT (Custom GPT com Actions):**

O ChatGPT não fala MCP — o equivalente é um Custom GPT com uma Action, usando o mesmo schema OpenAPI que o servidor já expõe em `/openapi.yaml`.

1. No ChatGPT: **Explore GPTs → Create → Configure → Create new action**
2. Em "Schema", cole o conteúdo de `https://SEU-DOMINIO/openapi.yaml` (ou importe pela URL, se o ChatGPT oferecer essa opção)
3. Em "Authentication", escolha **API Key**, tipo **Custom Header**, nome do header `x-api-key`, e cole a mesma chave do `MCP_API_KEY`
4. Salve — o GPT já consegue listar/criar/mover tarefas, convidar gente e conectar repositórios do GitHub, tudo pela conversa

**Importante:** essa chave dá acesso total (nível admin). Trate como senha — não cole em lugar público, e gere uma nova (rotacione o `.env`) se desconfiar que vazou.
