// Minimal in-memory D1 stand-in on top of node:sqlite, so the real migrations and handlers run in tests.
import { DatabaseSync } from 'node:sqlite';

const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  _exec() {
    const stmt = this.db.prepare(this.sql);
    if (isRead(this.sql)) {
      return { results: stmt.all(...this.params).map((r) => ({ ...r })), success: true, meta: {} };
    }
    const info = stmt.run(...this.params);
    return { results: [], success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
  }
  async first() {
    return this._exec().results[0] ?? null;
  }
  async all() {
    return this._exec();
  }
  async run() {
    return this._exec();
  }
}

export class D1Shim {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  exec(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
