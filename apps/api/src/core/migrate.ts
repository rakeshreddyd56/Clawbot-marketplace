/**
 * TASK-HARD-003: Programmatic migration runner for PostgreSQL.
 *
 * Runs SQL migration files from db/migrations/ in alphabetical order.
 * Tracks applied migrations in the `schema_migrations` table (created by migration 007).
 * Uses SHA256 checksums to detect modified migrations.
 *
 * Usage:
 *   - Called automatically by PgStore.init() when autoMigrate option is set
 *   - Can also be run standalone: `npx tsx src/core/migrate.ts`
 *
 * Design:
 *   - Reads all *.sql files from db/migrations/ sorted by filename
 *   - Checks schema_migrations for already-applied versions
 *   - Applies only new migrations in order
 *   - Each migration runs in its own transaction (unless it contains its own BEGIN/COMMIT)
 *   - Records the version + checksum in schema_migrations after successful application
 *
 * Safety:
 *   - NEVER modifies or re-runs an already-applied migration
 *   - Fails if a checksum mismatch is detected (migration file was modified after being applied)
 *   - Fails fast on any SQL error
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

interface MigrationFile {
  version: string;
  filename: string;
  filepath: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  filename: string;
  checksum: string;
  applied_at: string;
}

/**
 * Compute SHA256 checksum of a migration file's content.
 */
function checksumSql(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Extract version number from migration filename.
 * e.g., "001_initial_schema.sql" → "001"
 */
function extractVersion(filename: string): string {
  const match = filename.match(/^(\d+)/);
  if (!match) {
    throw new Error(`Migration file '${filename}' does not start with a numeric version prefix`);
  }
  return match[1];
}

/**
 * Load all migration files from the migrations directory.
 */
function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[migrate] Migrations directory not found: ${migrationsDir}`);
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Alphabetical sort ensures correct order (001, 002, ...)

  return files.map((filename) => {
    const filepath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filepath, 'utf-8');
    return {
      version: extractVersion(filename),
      filename,
      filepath,
      checksum: checksumSql(sql),
      sql
    };
  });
}

/**
 * Ensure the schema_migrations table exists.
 * This is safe to run multiple times (IF NOT EXISTS).
 */
async function ensureMigrationsTable(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    TEXT NOT NULL
    )
  `);
}

/**
 * Get all previously applied migrations.
 */
async function getAppliedMigrations(pool: InstanceType<typeof Pool>): Promise<Map<string, AppliedMigration>> {
  const { rows } = await pool.query<AppliedMigration>(
    'SELECT version, filename, checksum, applied_at::text FROM schema_migrations ORDER BY version'
  );
  const map = new Map<string, AppliedMigration>();
  for (const row of rows) {
    map.set(row.version, row);
  }
  return map;
}

/**
 * Detect if a migration SQL file manages its own transaction
 * (contains explicit BEGIN/COMMIT statements).
 */
function hasExplicitTransaction(sql: string): boolean {
  // Look for BEGIN and COMMIT outside of comments and strings
  const cleaned = sql
    .replace(/--.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove block comments
  return /\bBEGIN\b/i.test(cleaned) && /\bCOMMIT\b/i.test(cleaned);
}

/**
 * Run all pending migrations against the database.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @param migrationsDir - Path to the directory containing *.sql files
 * @returns Number of migrations applied
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsDir?: string
): Promise<number> {
  // Resolve migrations directory: try project root first, then relative paths
  const resolvedDir = migrationsDir ?? findMigrationsDir();
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 10_000
  });

  try {
    // Step 1: Ensure migration tracking table exists
    await ensureMigrationsTable(pool);

    // Step 2: Load migration files from disk
    const migrationFiles = loadMigrationFiles(resolvedDir);
    if (migrationFiles.length === 0) {
      console.log('[migrate] No migration files found');
      return 0;
    }

    // Step 3: Get already-applied migrations
    const applied = await getAppliedMigrations(pool);

    // Step 4: Validate checksums of already-applied migrations
    for (const file of migrationFiles) {
      const existing = applied.get(file.version);
      if (existing && existing.checksum !== file.checksum) {
        throw new Error(
          `[migrate] CHECKSUM MISMATCH for migration ${file.filename}. ` +
          `File was modified after being applied on ${existing.applied_at}. ` +
          `Expected checksum: ${existing.checksum}, got: ${file.checksum}. ` +
          `NEVER modify an already-applied migration. Create a new one instead.`
        );
      }
    }

    // Step 5: Apply pending migrations in order
    const pending = migrationFiles.filter((f) => !applied.has(f.version));
    if (pending.length === 0) {
      console.log(`[migrate] All ${migrationFiles.length} migrations already applied`);
      return 0;
    }

    console.log(`[migrate] Applying ${pending.length} pending migration(s)...`);

    for (const migration of pending) {
      console.log(`[migrate] Applying ${migration.filename}...`);

      const client = await pool.connect();
      try {
        if (hasExplicitTransaction(migration.sql)) {
          // Migration manages its own transaction — run as-is
          await client.query(migration.sql);
        } else {
          // Wrap in a transaction for safety
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query('COMMIT');
        }

        // Record the migration
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING',
          [migration.version, migration.filename, migration.checksum]
        );

        console.log(`[migrate] Applied: ${migration.filename}`);
      } catch (err) {
        // Rollback if we started a transaction
        if (!hasExplicitTransaction(migration.sql)) {
          await client.query('ROLLBACK').catch(() => {/* ignore rollback errors */});
        }
        throw new Error(
          `[migrate] Failed to apply ${migration.filename}: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        client.release();
      }
    }

    console.log(`[migrate] Successfully applied ${pending.length} migration(s)`);
    return pending.length;
  } finally {
    await pool.end();
  }
}

/**
 * Find the migrations directory by walking up from the current file.
 * Supports both source (src/) and compiled (dist/) execution paths.
 */
function findMigrationsDir(): string {
  // Try common locations relative to project root
  const candidates = [
    path.resolve(process.cwd(), 'db', 'migrations'),
    path.resolve(process.cwd(), '..', '..', 'db', 'migrations'),
    // From apps/api/src/core/ or apps/api/dist/core/
    path.resolve(import.meta.dirname ?? __dirname, '..', '..', '..', '..', 'db', 'migrations'),
    path.resolve(import.meta.dirname ?? __dirname, '..', '..', '..', '..', '..', 'db', 'migrations')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to project root
  return path.resolve(process.cwd(), 'db', 'migrations');
}

// ── CLI entry point ────────────────────────────────────────────────────────────
// Allows running migrations standalone:
//   DATABASE_URL=postgresql://... npx tsx src/core/migrate.ts
const isMainModule = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isMainModule) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL environment variable is required');
    process.exit(1);
  }

  runMigrations(databaseUrl)
    .then((count) => {
      console.log(`[migrate] Done. Applied ${count} migration(s).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] Migration failed:', err);
      process.exit(1);
    });
}
