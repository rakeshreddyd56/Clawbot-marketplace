#!/usr/bin/env tsx
/**
 * TASK-HARD-003: Database migration runner with version tracking.
 *
 * Tracks applied migrations in a `schema_migrations` table.
 * Applies pending migrations in lexicographic order.
 *
 * Usage:
 *   npx tsx db/migrate.ts                  # Apply pending migrations
 *   npx tsx db/migrate.ts --status         # Show migration status
 *   npx tsx db/migrate.ts --seed           # Apply migrations + seed data
 *
 * Requires: DATABASE_URL environment variable.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SEED_FILE = path.join(__dirname, 'seed.sql');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] ERROR: DATABASE_URL environment variable is required.');
    console.error('[migrate] Example: DATABASE_URL=postgresql://clawbot:clawbot_dev_secret@localhost:5432/clawbot_marketplace');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const showStatus = args.includes('--status');
  const runSeed = args.includes('--seed');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 10_000
  });

  try {
    // Ensure the tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        filename    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum    TEXT NOT NULL
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await pool.query(
      'SELECT version, filename, applied_at FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.map((r) => r.version));

    // Discover migration files
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (showStatus) {
      console.log('[migrate] Migration status:');
      console.log('─'.repeat(60));
      for (const file of files) {
        const version = file.replace('.sql', '');
        const status = appliedVersions.has(version) ? '✅ applied' : '⬜ pending';
        const appliedRow = applied.find((r) => r.version === version);
        const appliedAt = appliedRow ? ` (${new Date(appliedRow.applied_at).toISOString()})` : '';
        console.log(`  ${status}  ${file}${appliedAt}`);
      }
      console.log('─'.repeat(60));
      console.log(`  Total: ${files.length} | Applied: ${appliedVersions.size} | Pending: ${files.length - appliedVersions.size}`);
      return;
    }

    // Apply pending migrations
    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (appliedVersions.has(version)) {
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      // Simple checksum for change detection
      const { createHash } = await import('node:crypto');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

      console.log(`[migrate] Applying: ${file} ...`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
          [version, file, checksum]
        );
        await client.query('COMMIT');
        console.log(`[migrate] ✅ Applied: ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ❌ Failed: ${file}`);
        console.error(err);
        process.exit(1);
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      console.log('[migrate] All migrations are up to date.');
    } else {
      console.log(`[migrate] Applied ${appliedCount} migration(s).`);
    }

    // Optionally run seed data
    if (runSeed && fs.existsSync(SEED_FILE)) {
      console.log('[migrate] Applying seed data...');
      const seedSql = fs.readFileSync(SEED_FILE, 'utf-8');
      await pool.query(seedSql);
      console.log('[migrate] ✅ Seed data applied.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
