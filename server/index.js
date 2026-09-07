require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { connectDb, getDb, ObjectId } = require('./db');
const { toPublicUser, signToken, requireAuth, requireAdmin, requireAuthOrApiKey, requireAdminOrApiKey } = require('./auth');
const { pickColor, randomColor, initialsFromName } = require('./utils');
const githubSync = require('./githubSync');

const ROOT = path.join(__dirname, '..');
const app = express();
app.use(cors());
app.use(express.json());

function toPublicDoc(doc) {
  const { _id, ...rest } = doc;
  return Object.assign({ id: _id.toString() }, rest);
}

function objectId(id) {
  try { return new ObjectId(id); } catch (e) { return null; }
}

/* ---------- static frontend (explicit allowlist, never serves .git/server/etc) ---------- */
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(ROOT, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(ROOT, 'styles.css')));
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.get('/openapi.yaml', (req, res) => res.sendFile(path.join(__dirname, 'openapi.yaml')));

/* ---------- auth ---------- */
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  if (!email || !pass) return res.status(400).json({ error: 'Informe e-mail e senha.' });
  const userDoc = await getDb().collection('users').findOne({ email });
  if (!userDoc) return res.status(401).json({ error: 'Não encontramos uma conta com esse e-mail.' });
  const ok = await bcrypt.compare(pass, userDoc.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Senha incorreta.' });
  const token = signToken(userDoc._id.toString());
  res.json({ token, user: toPublicUser(userDoc) });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* ---------- users ---------- */
app.get('/api/users', requireAuthOrApiKey, async (req, res) => {
  const docs = await getDb().collection('users').find({}).toArray();
  res.json({ users: docs.map(toPublicUser) });
});

app.post('/api/users', requireAdminOrApiKey, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  const role = String(req.body.role || '').trim() || 'Colaborador';
  const isAdmin = req.body.isAdmin === true || req.body.isAdmin === 'true';
  if (!name) return res.status(400).json({ error: 'Informe o nome da pessoa.' });
  if (!email || !pass) return res.status(400).json({ error: 'Informe e-mail e senha temporária.' });
  if (pass.length < 6) return res.status(400).json({ error: 'A senha temporária precisa ter pelo menos 6 caracteres.' });
  const existing = await getDb().collection('users').findOne({ email });
  if (existing) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
  const passwordHash = await bcrypt.hash(pass, 10);
  const count = await getDb().collection('users').countDocuments();
  const githubUsername = String(req.body.githubUsername || '').trim();
  const doc = {
    name, email, role, passwordHash, isAdmin,
    initials: initialsFromName(name), color: pickColor(count),
    githubUsername: githubUsername || undefined,
    invitedBy: req.user.name, createdAt: new Date().toISOString()
  };
  const result = await getDb().collection('users').insertOne(doc);
  doc._id = result.insertedId;
  res.status(201).json({ user: toPublicUser(doc) });
});

app.delete('/api/users/:id', requireAdminOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  await getDb().collection('users').deleteOne({ _id });
  res.status(204).end();
});

/* ---------- projects ---------- */
app.get('/api/projects', requireAuthOrApiKey, async (req, res) => {
  const docs = await getDb().collection('projects').find({}).toArray();
  res.json({ projects: docs.map(toPublicDoc) });
});

app.post('/api/projects', requireAuthOrApiKey, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome do projeto.' });
  const count = await getDb().collection('projects').countDocuments();
  const doc = {
    name, desc: req.body.desc || 'Sem descrição.', color: pickColor(count),
    due: req.body.due || 'sem prazo', status: 'Planejado',
    budget: Number(req.body.hours) * 1000 || 30000, spent: 0, rate: 'R$ 130',
    createdAt: new Date().toISOString()
  };
  const result = await getDb().collection('projects').insertOne(doc);
  doc._id = result.insertedId;
  res.status(201).json({ project: toPublicDoc(doc) });
});

app.patch('/api/projects/:id', requireAuthOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  const patch = Object.assign({}, req.body);
  delete patch.id;
  await getDb().collection('projects').updateOne({ _id }, { $set: patch });
  const doc = await getDb().collection('projects').findOne({ _id });
  res.json({ project: toPublicDoc(doc) });
});

app.delete('/api/projects/:id', requireAuthOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  await getDb().collection('projects').deleteOne({ _id });
  res.status(204).end();
});

/* ---------- tasks ---------- */
app.get('/api/tasks', requireAuthOrApiKey, async (req, res) => {
  const docs = await getDb().collection('tasks').find({}).toArray();
  res.json({ tasks: docs.map(toPublicDoc) });
});

app.post('/api/tasks', requireAuthOrApiKey, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Informe o título da tarefa.' });
  const doc = {
    title, desc: req.body.desc || 'Sem descrição.', projectId: req.body.projectId || '',
    assigneeId: req.body.assigneeId || '', col: req.body.col || 'todo',
    priority: req.body.priority || 'Média', due: req.body.due || 'sem prazo',
    hours: req.body.hours || 0, tags: [], createdBy: req.user.name, createdById: req.user.id,
    checklist: [], files: [], comments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const result = await getDb().collection('tasks').insertOne(doc);
  doc._id = result.insertedId;
  res.status(201).json({ task: toPublicDoc(doc) });
});

app.patch('/api/tasks/:id', requireAuthOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  const before = await getDb().collection('tasks').findOne({ _id });
  if (!before) return res.status(404).json({ error: 'Tarefa não encontrada.' });
  const patch = Object.assign({}, req.body);
  delete patch.id;
  patch.updatedAt = new Date().toISOString();
  if (before.githubRepoId) await githubSync.pushTaskChangeToGithub(before, patch).catch(e => console.error(e));
  await getDb().collection('tasks').updateOne({ _id }, { $set: patch });
  const doc = await getDb().collection('tasks').findOne({ _id });
  res.json({ task: toPublicDoc(doc) });
});

app.delete('/api/tasks/:id', requireAuthOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  await getDb().collection('tasks').deleteOne({ _id });
  res.status(204).end();
});

/* ---------- GitHub Issues <-> Kanban sync ---------- */
app.get('/api/github/repos', requireAdminOrApiKey, async (req, res) => {
  const docs = await getDb().collection('githubRepos').find({}).toArray();
  res.json({ repos: docs.map(toPublicDoc) });
});

app.post('/api/github/repos', requireAdminOrApiKey, async (req, res) => {
  const owner = String(req.body.owner || '').trim();
  const repo = String(req.body.repo || '').trim();
  if (!owner || !repo) return res.status(400).json({ error: 'Informe owner e repo (ex: minha-empresa/meu-projeto).' });
  try {
    const result = await githubSync.connectRepo(owner, repo);
    res.status(201).json({ repo: toPublicDoc(result.repo), project: toPublicDoc(result.project), summary: result.summary });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/github/repos/:id', requireAdminOrApiKey, async (req, res) => {
  const _id = objectId(req.params.id);
  if (!_id) return res.status(400).json({ error: 'ID inválido.' });
  await getDb().collection('githubRepos').deleteOne({ _id });
  res.status(204).end();
});

app.post('/api/github/sync', requireAdminOrApiKey, async (req, res) => {
  try {
    const results = await githubSync.syncAll();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
connectDb().then(() => {
  app.listen(PORT, () => console.log('Genesis server listening on port ' + PORT));
  if (process.env.GITHUB_TOKEN) {
    const minutes = Number(process.env.GITHUB_SYNC_MINUTES) || 5;
    setInterval(() => githubSync.syncAll().catch(e => console.error('github sync tick failed:', e.message)), minutes * 60000);
    console.log('GitHub sync enabled, polling every ' + minutes + ' min.');
  }
}).catch(e => {
  console.error('Failed to connect to MongoDB:', e.message);
  process.exit(1);
});
