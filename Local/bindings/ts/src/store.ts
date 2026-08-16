// store.ts - Despia Local over real SQLite.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Node ships SQLite (node:sqlite), so this binding is not a simulation of the
// data plane's semantics - it IS SQLite, with real savepoints, real rollback and
// real VACUUM INTO. That matters more here than it would elsewhere: the fixtures
// in OpenSource/Conformance/local assert transactional behaviour, and a
// hand-rolled in-memory approximation would agree with them for the wrong
// reasons and then disagree with the native bindings for real ones.
//
// Three design choices worth stating, because each one is a promise:
//
//   1. A store must be DECLARED. Writing to an unknown store is a typed error,
//      never an implicit create - silent schema creation is how data planes rot.
//   2. Values are parameterised, always. A value never becomes SQL, and the
//      injection fixture is what says so.
//   3. Snapshot and export URLs are CONTAINER-RELATIVE (file:///snapshots/x.db).
//      An absolute path would leak the app container's layout to whatever asked,
//      including the page surface, for no benefit to the caller.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Dict = { [k: string]: any };
export type TypedError = { code: string; message?: string; data?: Dict };

export type Embedding = { model: string; dimension: number; revision?: string };

export class LocalError extends Error {
  code: string;
  data?: Dict;
  constructor(code: string, message?: string, data?: Dict) {
    super(message ?? code);
    this.code = code;
    this.data = data;
  }
  get wire(): TypedError {
    return { code: this.code, ...(this.message ? { message: this.message } : {}), ...(this.data ? { data: this.data } : {}) };
  }
}

export class Local {
  #db: DatabaseSync;
  #dir: string;
  #file: string;
  #stores = new Set<string>();
  #indexes = new Map<string, Embedding>();

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, 'base.db');
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
    this.#db = new DatabaseSync(this.#file);
    // WAL keeps a reader from blocking the writer, which is what lets a
    // concurrent app write proceed while an agent's approval is pending.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS _stores (name TEXT PRIMARY KEY)`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS _rows (
      store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (store, key))`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS _vectors (
      idx TEXT NOT NULL, key TEXT NOT NULL, vector TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (idx, key))`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS _index_meta (
      idx TEXT PRIMARY KEY, model TEXT NOT NULL, dimension INTEGER NOT NULL, revision TEXT)`);
    this.#reload();
  }

  #reload(): void {
    this.#stores = new Set(
      (this.#db.prepare('SELECT name FROM _stores').all() as Dict[]).map((r) => String(r.name)));
    this.#indexes = new Map(
      (this.#db.prepare('SELECT * FROM _index_meta').all() as Dict[]).map((r) => [
        String(r.idx),
        { model: String(r.model), dimension: Number(r.dimension), revision: r.revision ?? undefined },
      ]));
  }

  declareStore(name: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO _stores (name) VALUES (?)').run(name);
    this.#stores.add(name);
  }

  close(): void {
    this.#db.close();
  }

  /** An abrupt process loss. Committed data survives; an open savepoint does
   *  not - which is the whole difference between a scope and a backup. */
  crash(): void {
    this.#db.close();
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#reload();
  }

  // --- rows ------------------------------------------------------------

  put(store: string, key: string, value: Dict): Dict {
    this.#requireStore(store);
    this.#db.prepare('INSERT INTO _rows (store, key, value) VALUES (?, ?, ?) ' +
                     'ON CONFLICT(store, key) DO UPDATE SET value = excluded.value')
        .run(store, key, JSON.stringify(value));
    return { ok: true };
  }

  get(store: string, key: string): Dict {
    this.#requireStore(store);
    const row = this.#db.prepare('SELECT value FROM _rows WHERE store = ? AND key = ?')
        .get(store, key) as Dict | undefined;
    // A miss is `null`, not an error: asking for something that is not there is
    // an ordinary thing for a caller to do.
    return { value: row ? JSON.parse(String(row.value)) : null };
  }

  delete(store: string, key: string): Dict {
    this.#requireStore(store);
    const before = this.#count(store);
    this.#db.prepare('DELETE FROM _rows WHERE store = ? AND key = ?').run(store, key);
    return { deleted: before - this.#count(store) };
  }

  /** Filtered and ordered rows. `where` and `order` are a small declared
   *  vocabulary rather than a SQL passthrough, which is what keeps values as
   *  parameters and keeps the surface identical on every binding. */
  query(store: string, where: Dict = {}, order: Dict[] = []): Dict {
    this.#requireStore(store);
    let rows = (this.#db.prepare('SELECT key, value FROM _rows WHERE store = ? ORDER BY key')
        .all(store) as Dict[])
        .map((r) => ({ key: String(r.key), value: JSON.parse(String(r.value)) }));

    for (const [field, condition] of Object.entries(where)) {
      for (const [op, operand] of Object.entries(condition as Dict)) {
        rows = rows.filter((row) => {
          const actual = row.value?.[field];
          switch (op) {
            case 'eq': return actual === operand;
            case 'ne': return actual !== operand;
            case 'gt': return actual > operand;
            case 'gte': return actual >= operand;
            case 'lt': return actual < operand;
            case 'lte': return actual <= operand;
            case 'contains': return String(actual ?? '').includes(String(operand));
            default:
              throw new LocalError('unknown_operator', `no such query operator: ${op}`, { op });
          }
        });
      }
    }
    for (const clause of [...order].reverse()) {
      const field = String(clause.field);
      const sign = String(clause.dir ?? 'asc') === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const x = a.value?.[field];
        const y = b.value?.[field];
        return x === y ? 0 : (x > y ? sign : -sign);
      });
    }
    return { rows };
  }

  stats(): Dict {
    return {
      stores: [...this.#stores].sort().map((name) => ({ name, rows: this.#count(name) })),
    };
  }

  // --- savepoints ------------------------------------------------------

  savepoint(name: string): Dict {
    this.#db.exec(`SAVEPOINT ${this.#ident(name)}`);
    return { ok: true };
  }

  release(name: string): Dict {
    this.#db.exec(`RELEASE ${this.#ident(name)}`);
    return { ok: true };
  }

  rollback(name: string): Dict {
    // ROLLBACK TO leaves the savepoint in place; releasing it too is what makes
    // the scope actually end, which is what a caller means by "roll back".
    this.#db.exec(`ROLLBACK TO ${this.#ident(name)}`);
    this.#db.exec(`RELEASE ${this.#ident(name)}`);
    return { ok: true };
  }

  // --- snapshots -------------------------------------------------------

  /** A durable point-in-time copy. Writes after it cannot reach it, which is
   *  what makes "there is always a backup from before the agent touched
   *  anything" a fact rather than a hope. */
  snapshot(label: string): Dict {
    const path = this.#snapshotPath(label);
    rmSync(path, { force: true });
    this.#db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return { ok: true, label, url: `file:///snapshots/${label}.db` };
  }

  snapshots(): Dict {
    const dir = join(this.#dir, 'snapshots');
    if (!existsSync(dir)) return { snapshots: [] };
    const entries: Dict[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.db')) continue;
      const label = name.slice(0, -3);
      entries.push({ label, bytes: statSync(join(dir, name)).size, url: `file:///snapshots/${name}` });
    }
    return { snapshots: entries };
  }

  restore(label: string): Dict {
    const path = this.#snapshotPath(label);
    if (!existsSync(path)) {
      throw new LocalError('unknown_snapshot', `no snapshot labelled ${label}`, { label });
    }
    this.#db.close();
    copyFileSync(path, this.#file);
    rmSync(`${this.#file}-wal`, { force: true });
    rmSync(`${this.#file}-shm`, { force: true });
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#reload();
    return { ok: true };
  }

  /** A REFERENCE, never bytes: the same law the AI package's audio blocks obey. */
  export(label: string): Dict {
    const path = this.#snapshotPath(label);
    if (!existsSync(path)) {
      throw new LocalError('unknown_snapshot', `no snapshot labelled ${label}`, { label });
    }
    return { url: `file:///snapshots/${label}.db`, bytes: statSync(path).size };
  }

  // --- vectors ---------------------------------------------------------

  indexUpsert(idx: string, key: string, vector: number[], embedding: Embedding, value: Dict): Dict {
    const known = this.#indexes.get(idx);
    if (!known) {
      this.#db.prepare('INSERT INTO _index_meta (idx, model, dimension, revision) VALUES (?, ?, ?, ?)')
          .run(idx, embedding.model, embedding.dimension, embedding.revision ?? null);
      this.#indexes.set(idx, embedding);
    } else {
      // Catch it on the way IN. An index is homogeneous by construction, so the
      // corrupting write fails instead of poisoning every later search.
      this.#requireSameEmbedding(idx, known, embedding);
    }
    if (vector.length !== embedding.dimension) {
      throw new LocalError('embedding_mismatch', 'the vector does not match its declared dimension',
                          { reason: 'dimension', stored: embedding.dimension, query: vector.length });
    }
    this.#db.prepare('INSERT INTO _vectors (idx, key, vector, value) VALUES (?, ?, ?, ?) ' +
                     'ON CONFLICT(idx, key) DO UPDATE SET vector = excluded.vector, value = excluded.value')
        .run(idx, key, JSON.stringify(vector), JSON.stringify(value ?? {}));
    return { ok: true };
  }

  indexInfo(idx: string): Dict {
    const embedding = this.#indexes.get(idx);
    const count = (this.#db.prepare('SELECT COUNT(*) AS n FROM _vectors WHERE idx = ?')
        .get(idx) as Dict).n;
    return { count: Number(count), ...(embedding ? { embedding } : {}) };
  }

  indexSearch(idx: string, vector: number[], embedding: Embedding, k: number): Dict {
    const known = this.#indexes.get(idx);
    if (!known) return { hits: [] };
    this.#requireSameEmbedding(idx, known, embedding);
    const rows = this.#db.prepare('SELECT key, vector, value FROM _vectors WHERE idx = ?')
        .all(idx) as Dict[];
    const hits = rows.map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value)),
      distance: euclidean(vector, JSON.parse(String(row.vector))),
    }));
    // Nearest first, and the distance rides along so a caller can apply its own
    // threshold instead of trusting a black box.
    hits.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
    return { hits: hits.slice(0, k > 0 ? k : hits.length) };
  }

  indexDelete(idx: string, key: string): Dict {
    this.#db.prepare('DELETE FROM _vectors WHERE idx = ? AND key = ?').run(idx, key);
    return { ok: true };
  }

  /** The escape hatch an embedding_mismatch points at. */
  indexReindex(idx: string, embedding: Embedding, vectors: Dict[]): Dict {
    this.#db.prepare('DELETE FROM _vectors WHERE idx = ?').run(idx);
    this.#db.prepare('INSERT INTO _index_meta (idx, model, dimension, revision) VALUES (?, ?, ?, ?) ' +
                     'ON CONFLICT(idx) DO UPDATE SET model = excluded.model, ' +
                     'dimension = excluded.dimension, revision = excluded.revision')
        .run(idx, embedding.model, embedding.dimension, embedding.revision ?? null);
    this.#indexes.set(idx, embedding);
    for (const row of vectors) {
      this.indexUpsert(idx, String(row.key), row.vector as number[], embedding, (row.value ?? {}) as Dict);
    }
    return { ok: true, count: vectors.length };
  }

  // --- plumbing --------------------------------------------------------

  #requireStore(store: string): void {
    if (this.#stores.has(store)) return;
    throw new LocalError('unknown_store', `no store named ${store}`, { store });
  }

  #requireSameEmbedding(idx: string, stored: Embedding, query: Embedding): void {
    // Three distinct reasons, because the fix differs for each. A model
    // mismatch at the same width is the dangerous one: without the model id
    // this search would return confident nonsense.
    if (stored.dimension !== query.dimension) {
      throw new LocalError('embedding_mismatch', 'the query embedding has a different dimension',
                          { reason: 'dimension', stored: stored.dimension, query: query.dimension, reindex: idx });
    }
    if (stored.model !== query.model) {
      throw new LocalError('embedding_mismatch', 'the query embedding comes from a different model',
                          { reason: 'model', stored: stored.model, query: query.model, reindex: idx });
    }
    if ((stored.revision ?? null) !== (query.revision ?? null)) {
      throw new LocalError('embedding_mismatch', 'the query embedding is a different revision',
                          { reason: 'revision', stored: stored.revision, query: query.revision, reindex: idx });
    }
  }

  #count(store: string): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM _rows WHERE store = ?')
        .get(store) as Dict).n);
  }

  #snapshotPath(label: string): string {
    if (!/^[\w.-]+$/.test(label)) {
      throw new LocalError('invalid_label', 'a snapshot label is letters, digits, dot, dash or underscore');
    }
    return join(this.#dir, 'snapshots', `${label}.db`);
  }

  // SQLite has no parameter slot for an identifier, so savepoint names are
  // validated rather than interpolated hopefully.
  #ident(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new LocalError('invalid_savepoint', `not a valid savepoint name: ${name}`);
    }
    return name;
  }
}

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
