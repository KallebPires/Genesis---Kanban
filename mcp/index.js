#!/usr/bin/env node
// Local MCP server for Genesis Kanban. Runs on your machine (spawned by Claude
// Desktop/Code over stdio) and talks to your Genesis server's REST API over
// HTTPS using a static API key — it never touches a database directly, and
// it doesn't hardcode any specific GitHub account or repository: every repo
// is passed in by whoever calls the tools, at call time.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.GENESIS_API_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.GENESIS_API_KEY || '';

if (!API_URL || !API_KEY) {
  console.error('genesis-mcp: defina GENESIS_API_URL e GENESIS_API_KEY antes de rodar.');
  process.exit(1);
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  opts.headers = Object.assign({ 'x-api-key': API_KEY }, opts.headers);
  if (opts.body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  const res = await fetch(API_URL + '/api' + path, opts);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
  return json;
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'genesis-kanban', version: '1.0.0' });

server.tool('list_projects', 'Lista todos os projetos do Kanban Genesis.', {}, async () => {
  const data = await api('/projects');
  return textResult(data.projects);
});

server.tool('create_project', 'Cria um novo projeto no Kanban.', {
  name: z.string().describe('Nome do projeto'),
  desc: z.string().optional().describe('Descrição do projeto'),
  due: z.string().optional().describe('Prazo, texto livre (ex: "30 out")'),
  hours: z.number().optional().describe('Orçamento em milhares de reais (ex: 60 = R$60k)')
}, async (args) => {
  const data = await api('/projects', { method: 'POST', body: args });
  return textResult(data.project);
});

server.tool('list_tasks', 'Lista todas as tarefas do Kanban, com projeto, responsável, coluna e prioridade.', {}, async () => {
  const data = await api('/tasks');
  return textResult(data.tasks);
});

server.tool('create_task', 'Cria uma nova tarefa em um projeto do Kanban.', {
  title: z.string().describe('Título da tarefa'),
  desc: z.string().optional(),
  projectId: z.string().describe('ID do projeto (veja list_projects)'),
  assigneeId: z.string().optional().describe('ID do usuário responsável (veja list_users)'),
  col: z.enum(['backlog', 'todo', 'doing', 'review', 'done']).optional().describe('Coluna inicial (padrão: todo)'),
  priority: z.enum(['Alta', 'Média', 'Baixa']).optional(),
  due: z.string().optional(),
  hours: z.number().optional().describe('Estimativa em horas')
}, async (args) => {
  const data = await api('/tasks', { method: 'POST', body: args });
  return textResult(data.task);
});

server.tool('update_task', 'Atualiza uma tarefa existente (mover de coluna, trocar responsável/prioridade, etc). Se a tarefa estiver ligada a uma Issue do GitHub, mover para "done" fecha a issue automaticamente, e mover para fora de "done" reabre.', {
  taskId: z.string().describe('ID da tarefa (veja list_tasks)'),
  col: z.enum(['backlog', 'todo', 'doing', 'review', 'done']).optional(),
  assigneeId: z.string().optional(),
  priority: z.enum(['Alta', 'Média', 'Baixa']).optional(),
  title: z.string().optional(),
  desc: z.string().optional(),
  due: z.string().optional()
}, async ({ taskId, ...patch }) => {
  const data = await api('/tasks/' + taskId, { method: 'PATCH', body: patch });
  return textResult(data.task);
});

server.tool('delete_task', 'Exclui uma tarefa do Kanban permanentemente.', {
  taskId: z.string()
}, async ({ taskId }) => {
  await api('/tasks/' + taskId, { method: 'DELETE' });
  return textResult({ deleted: taskId });
});

server.tool('list_users', 'Lista as pessoas cadastradas no Genesis (equipe).', {}, async () => {
  const data = await api('/users');
  return textResult(data.users);
});

server.tool('list_github_repos', 'Lista quais repositórios do GitHub estão conectados e sincronizando Issues com o Kanban.', {}, async () => {
  const data = await api('/github/repos');
  return textResult(data.repos);
});

server.tool('connect_github_repo', 'Conecta um repositório do GitHub ao Kanban: cria um projeto e importa as Issues como tarefas. O repositório não é fixo — informe qual conectar a cada chamada.', {
  owner: z.string().describe('Dono do repositório no GitHub (usuário ou organização)'),
  repo: z.string().describe('Nome do repositório')
}, async ({ owner, repo }) => {
  const data = await api('/github/repos', { method: 'POST', body: { owner, repo } });
  return textResult(data);
});

server.tool('sync_github', 'Força uma sincronização imediata de todos os repositórios GitHub conectados com o Kanban (puxa Issues novas/atualizadas).', {}, async () => {
  const data = await api('/github/sync', { method: 'POST' });
  return textResult(data.results);
});

const transport = new StdioServerTransport();
await server.connect(transport);
