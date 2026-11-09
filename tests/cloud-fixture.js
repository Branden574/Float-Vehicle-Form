import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Opt-in tests use isolated schemas; never clear the actual fleet schema.
export async function cloudFixture(t) {
  if (!process.env.FLEET_TEST_ADMIN_DATABASE_URL) return;
  const schema = 'qa_' + randomBytes(10).toString('hex');
  const admin = new pg.Client({
    connectionString: process.env.FLEET_TEST_ADMIN_DATABASE_URL,
    ssl: {
      ca: readFileSync(new URL('../server/certs/supabase-ca.crt', import.meta.url), 'utf8'),
      rejectUnauthorized: true,
    },
  });
  await admin.connect();
  const migration = readFileSync(
    new URL('../supabase/migrations/20261109190849_fleet_cloud.sql', import.meta.url),
    'utf8',
  ).replace(/\bfleet\b/g, schema);
  await admin.query(migration);
  await admin.query(
    readFileSync(
      new URL('../supabase/migrations/20261109214534_account_deletion.sql', import.meta.url),
      'utf8',
    ).replace(/\bfleet\b/g, schema),
  );
  process.env.DATABASE_SCHEMA = schema;
  return async () => {
    if (!/^qa_[a-f0-9]{20}$/.test(schema)) throw new Error('Invalid test schema');
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };
}
