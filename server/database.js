import Database from 'better-sqlite3';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

pg.types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds safe range');
  return number;
});

const contexts = new AsyncLocalStorage();
const locks = new Map();
async function exclusive(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, pending);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === pending) locks.delete(key);
  }
}

function postgresSQL(sql, schema) {
  let index = 0;
  // Our prepared statements contain no question marks in SQL literals.
  sql = sql.replace(/\?/g, () => `$${++index}`).replace(/ COLLATE NOCASE/gi, '');
  if (/^INSERT OR IGNORE /i.test(sql))
    sql = sql.replace(/^INSERT OR IGNORE /i, 'INSERT ') + ' ON CONFLICT DO NOTHING';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  const tables =
    'schema_migrations|settings|users|sessions|vehicles|trips|photos|reviews|revisions|odometer_replacements|audit|notifications|idempotency|privacy_meta|login_codes|upload_tickets|rate_limits|deletion_jobs';
  sql = sql.replace(
    new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+(${tables})\\b`, 'gi'),
    (_, keyword, table) => `${keyword} ${schema}.${table}`,
  );
  return sql;
}

export function openDatabase(dataDir, connectionString = process.env.DATABASE_URL) {
  if (connectionString) {
    const schema = process.env.DATABASE_SCHEMA || 'fleet';
    const pool = new pg.Pool({
      connectionString,
      ssl: {
        ca: readFileSync(new URL('./certs/supabase-ca.crt', import.meta.url), 'utf8'),
        rejectUnauthorized: true,
      },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    const query = async (text, values = []) => {
      const client = contexts.getStore()?.pool === pool ? contexts.getStore().client : pool;
      try {
        const execute = () => client.query(postgresSQL(text, schema), values);
        return await (client === pool ? execute() : exclusive(client, execute));
      } catch (error) {
        if (['23505', '23503', '23514', '23502'].includes(error.code))
          error.code = `SQLITE_CONSTRAINT_${error.code}`;
        throw error;
      }
    };
    const transaction = (fn) => {
      const run = async (...args) => {
        if (contexts.getStore()?.pool === pool) return fn(...args);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout='15s'");
          // Fleet mutations are short; one transaction-scoped lock preserves SQLite's
          // serialized write semantics across serverless instances, including quota checks.
          await client.query('SELECT pg_advisory_xact_lock(64201824)');
          const result = await contexts.run({ pool, client }, () => fn(...args));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      run.immediate = run;
      return run;
    };
    return {
      kind: 'postgres',
      pool,
      transaction,
      prepare: (sql) => ({
        all: async (...args) => (await query(sql, args)).rows,
        get: async (...args) => (await query(sql, args)).rows[0],
        run: async (...args) => ({ changes: (await query(sql, args)).rowCount }),
      }),
      exec: async (sql) => query(sql),
      close: () => pool.end(),
    };
  }
  const filename = path.resolve(dataDir, 'fleet.sqlite');
  const raw = new Database(filename);
  const invoke = (fn) => (contexts.getStore()?.database === raw ? fn() : exclusive(filename, fn));
  const transaction = (fn) => {
    const run = (...args) => {
      if (contexts.getStore()?.database === raw) return fn(...args);
      return exclusive(filename, async () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await contexts.run({ database: raw }, () => fn(...args));
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          raw.exec('ROLLBACK');
          throw error;
        }
      });
    };
    run.immediate = run;
    return run;
  };
  return {
    kind: 'sqlite',
    transaction,
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return Object.fromEntries(
        ['all', 'get', 'run'].map((method) => [
          method,
          (...args) => invoke(() => statement[method](...args)),
        ]),
      );
    },
    exec: (sql) => invoke(() => raw.exec(sql)),
    pragma: (...args) => invoke(() => raw.pragma(...args)),
    close: () => invoke(() => raw.close()),
  };
}
