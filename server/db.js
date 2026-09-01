const { MongoClient, ObjectId } = require('mongodb');

let client;
let db;

async function connectDb() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_DB || 'genesis';
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not connected yet');
  return db;
}

module.exports = { connectDb, getDb, ObjectId };
