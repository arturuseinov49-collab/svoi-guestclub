import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '../database.mjs';

// The encryption key lives in the service environment, outside SQLite and its backups.
export class PosSecrets {
  constructor(store, masterKey) {
    this.sql = store.sql;
    this.key = masterKey ? Buffer.from(masterKey, 'base64') : null;
    if (this.key && (this.key.length !== 32 || this.key.toString('base64') !== masterKey)) throw new Error('Invalid POS_MASTER_KEY');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pos_credentials (
      connection_id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, encrypted TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, verified_at INTEGER
    );`);
  }
  available() { return !!this.key; }
  save(id, venueId, config) {
    if (!this.key) throw new ApiError(503, 'Хранение ключей кассы ещё не настроено на сервере');
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${id}:${venueId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    this.sql.prepare(`INSERT INTO pos_credentials(connection_id,venue_id,encrypted) VALUES(?,?,?)
      ON CONFLICT(connection_id) DO UPDATE SET encrypted=excluded.encrypted,revision=revision+1,verified_at=NULL`).run(id, venueId, encrypted);
  }
  get(id) {
    const row = this.sql.prepare('SELECT * FROM pos_credentials WHERE connection_id=?').get(id);
    if (!row) return null;
    if (!this.key) throw new ApiError(503, 'Хранилище ключей кассы недоступно');
    try {
      const bytes = Buffer.from(row.encrypted, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${id}:${row.venue_id}`)); decipher.setAuthTag(bytes.subarray(12, 28));
      const config = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      return { config, revision: row.revision, verifiedAt: row.verified_at };
    } catch { throw new ApiError(503, 'Не удалось открыть ключи кассы. Обратитесь к администратору сервера'); }
  }
  revision(id) { return this.sql.prepare('SELECT revision FROM pos_credentials WHERE connection_id=?').get(id)?.revision; }
  verified(id, revision, at) {
    this.sql.prepare('UPDATE pos_credentials SET verified_at=? WHERE connection_id=? AND revision=?').run(at, id, revision);
  }
}
