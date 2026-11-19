import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }

  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS observations (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, observed_at TEXT NOT NULL, observation TEXT NOT NULL);`);
    return this;
  }

  async preserve(document) {
    const computed = createHash('sha256').update(document.bytes).digest('hex');
    if (document.digest && document.digest !== computed) throw new Error('原文摘要与取得内容不一致');
    const digest = computed;
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }

  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare(`INSERT INTO receipts VALUES(?,?,?,?,?)
      ON CONFLICT(scope,business_key,digest) DO UPDATE SET record=excluded.record, decision=excluded.decision`)
      .run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }

  observe(scope, key, observation) {
    this.database.prepare('INSERT INTO observations VALUES(?,?,?,?)').run(scope, key, observation.observedAt ?? new Date().toISOString(), JSON.stringify(observation));
  }

  records(scope) {
    return this.rows(scope).sort((left, right) => left.business_key.localeCompare(right.business_key) || left.digest.localeCompare(right.digest));
  }

  rows(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=?').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }

  observations(scope) {
    return this.database.prepare('SELECT * FROM observations WHERE scope=? ORDER BY observed_at').all(scope).map(row => ({ ...row, observation: JSON.parse(row.observation) }));
  }

  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }

  close() { this.database?.close(); }
}
