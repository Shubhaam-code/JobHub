// Temporary diagnostic: inspect the admin account as stored in Atlas.
import { MongoClient } from 'mongodb';
import fs from 'node:fs';

const envText = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
const uri = /^\s*MONGODB_URI\s*=(.*)$/m.exec(envText)[1].trim();

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();

const admin = client.db().admin();
const { databases } = await admin.listDatabases();
console.log('databases:', databases.map((d) => d.name).join(', '));

for (const { name } of databases) {
  if (['admin', 'local', 'config'].includes(name)) continue;
  const db = client.db(name);
  const cols = (await db.listCollections().toArray()).map((c) => c.name);
  console.log(`\n[db ${name}] collections: ${cols.join(', ')}`);

  for (const col of cols) {
    if (!/user/i.test(col)) continue;
    const docs = await db.collection(col).find({}).toArray();
    console.log(`  ${col}: ${docs.length} docs`);
    for (const d of docs) {
      const h = typeof d.passwordHash === 'string' ? d.passwordHash : null;
      const parts = h ? h.split('$') : [];
      console.log(
        '   ',
        JSON.stringify({
          _id: String(d._id),
          email: d.email,
          role: d.role,
          keys: Object.keys(d),
          hashParts: parts.length,
          scheme: parts[0] ?? null,
          saltLen: parts[1]?.length ?? null,
          keyLen: parts[2]?.length ?? null,
          hashLen: h?.length ?? null,
        }),
      );
    }
    const idx = await db.collection(col).indexes();
    console.log('    indexes:', JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique }))));
  }
}

await client.close();
