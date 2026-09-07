const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb, ObjectId } = require('./db');

function toPublicUser(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    name: doc.name,
    role: doc.role,
    email: doc.email,
    initials: doc.initials,
    color: doc.color,
    isAdmin: !!doc.isAdmin,
    githubUsername: doc.githubUsername || '',
    createdAt: doc.createdAt
  };
}

function signToken(userId) {
  return jwt.sign({ uid: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
  let userDoc;
  try {
    userDoc = await getDb().collection('users').findOne({ _id: new ObjectId(payload.uid) });
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida.' });
  }
  if (!userDoc) return res.status(401).json({ error: 'Usuário não existe mais.' });
  req.userDoc = userDoc;
  req.user = toPublicUser(userDoc);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Apenas administradores podem fazer isso.' });
  next();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const SERVICE_USER = { id: 'service', name: 'Integração (MCP/GPT)', role: 'Serviço', isAdmin: true };

function matchesApiKey(req) {
  const key = req.headers['x-api-key'];
  return !!(key && process.env.MCP_API_KEY && safeEqual(key, process.env.MCP_API_KEY));
}

// Lets an automated client (the local MCP server, or a ChatGPT Custom GPT Action)
// authenticate with a single static key instead of a per-user login. Falls back to
// normal JWT auth (any logged-in user) when no key is sent.
async function requireAuthOrApiKey(req, res, next) {
  if (matchesApiKey(req)) { req.user = SERVICE_USER; return next(); }
  return requireAuth(req, res, next);
}

// Same, but requires admin when falling back to a JWT (the API key always counts as admin).
async function requireAdminOrApiKey(req, res, next) {
  if (matchesApiKey(req)) { req.user = SERVICE_USER; return next(); }
  return requireAuth(req, res, () => requireAdmin(req, res, next));
}

module.exports = { toPublicUser, signToken, requireAuth, requireAdmin, requireAuthOrApiKey, requireAdminOrApiKey };
