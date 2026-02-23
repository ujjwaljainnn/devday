// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js ships no declaration file
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';

// Minimal type surface we actually use from sql.js
interface SqlJsStatic {
  Database: new (data: Buffer | Uint8Array) => SqlJsDb;
}
interface SqlJsDb {
  prepare(sql: string): SqlJsStmt;
  close(): void;
}
interface SqlJsStmt {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

let SQL: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await (initSqlJs as unknown as () => Promise<SqlJsStatic>)();
  }
  return SQL!;
}

/**
 * Thin read-only SQLite wrapper over sql.js that mimics
 * the better-sqlite3 .prepare().all() call pattern.
 */
export class ReadonlyDatabase {
  private db: SqlJsDb;

  private constructor(db: SqlJsDb) {
    this.db = db;
  }

  static async open(filePath: string): Promise<ReadonlyDatabase> {
    const sqlJs = await getSqlJs();
    const fileBuffer = readFileSync(filePath);
    const db = new sqlJs.Database(fileBuffer);
    return new ReadonlyDatabase(db);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all<T = Record<string, any>>(sql: string, ...params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  close(): void {
    this.db.close();
  }
}
