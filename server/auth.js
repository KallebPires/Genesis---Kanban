const jwt = require('jsonwebtoken');
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

module.exports = { toPublicUser, signToken, requireAuth, requireAdmin };
