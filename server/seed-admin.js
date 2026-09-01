// One-time bootstrap: creates (or promotes) the first admin account.
// Usage: node seed-admin.js "Nome Completo" email@exemplo.com senha123 [Função]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDb, getDb } = require('./db');
const { pickColor, initialsFromName } = require('./utils');

async function main() {
  const [name, email, pass, role] = process.argv.slice(2);
  if (!name || !email || !pass) {
    console.error('Uso: node seed-admin.js "Nome Completo" email@exemplo.com senha123 [Função]');
    process.exit(1);
  }
  if (pass.length < 6) {
    console.error('A senha precisa ter pelo menos 6 caracteres.');
    process.exit(1);
  }
  await connectDb();
  const db = getDb();
  const emailNorm = email.trim().toLowerCase();
  const existing = await db.collection('users').findOne({ email: emailNorm });
  if (existing) {
    await db.collection('users').updateOne({ _id: existing._id }, { $set: { isAdmin: true } });
    console.log('Conta já existia — promovida a admin:', emailNorm);
  } else {
    const passwordHash = await bcrypt.hash(pass, 10);
    const count = await db.collection('users').countDocuments();
    await db.collection('users').insertOne({
      name, email: emailNorm, role: role || 'Admin', passwordHash,
      initials: initialsFromName(name), color: pickColor(count),
      isAdmin: true, createdAt: new Date().toISOString()
    });
    console.log('Admin criado:', emailNorm);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
