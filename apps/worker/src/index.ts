/**
 * TASK-HARD-004: Temporal worker runtime entrypoint.
 *
 * Creates a Temporal worker that:
 * - Connects to the Temporal server (or dev server for local dev)
 * - Registers all marketplace workflow types
 * - Registers activity implementations
 * - Starts polling the task queue for work
 *
 * Environment variables:
 * - TEMPORAL_ADDRESS: Temporal server address (required)
 * - TEMPORAL_NAMESPACE: Temporal namespace (default: "default")
 * - TEMPORAL_TASK_QUEUE: Task queue name (default: "marketplace-event")
 * - TEMPORAL_TLS_CERT: Path to TLS cert file (optional, for mTLS)
 * - TEMPORAL_TLS_KEY: Path to TLS key file (optional, for mTLS)
 * - TEMPORAL_MAX_CONCURRENT_ACTIVITIES: Max concurrent activities (default: 10)
 * - TEMPORAL_MAX_CONCURRENT_WORKFLOWS: Max concurrent workflow tasks (default: 10)
 *
 * Graceful shutdown: Handles SIGINT/SIGTERM for clean draining.
 */

import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

// ─── Configuration ────────────────────────────────────────────────────────────

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'marketplace-event';
const TEMPORAL_TLS_CERT = process.env.TEMPORAL_TLS_CERT;
const TEMPORAL_TLS_KEY = process.env.TEMPORAL_TLS_KEY;
const MAX_CONCURRENT_ACTIVITIES = parseInt(process.env.TEMPORAL_MAX_CONCURRENT_ACTIVITIES ?? '10', 10);
const MAX_CONCURRENT_WORKFLOW_TASKS = parseInt(process.env.TEMPORAL_MAX_CONCURRENT_WORKFLOWS ?? '10', 10);

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level: 'info' | 'error' | 'warn', msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    service: 'temporal-worker',
    taskQueue: TEMPORAL_TASK_QUEUE,
    namespace: TEMPORAL_NAMESPACE,
    timestamp: new Date().toISOString(),
    ...extra
  }));
}

// ─── Worker Bootstrap ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log('info', 'Starting Temporal worker', {
    address: TEMPORAL_ADDRESS,
    maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
    maxConcurrentWorkflowTasks: MAX_CONCURRENT_WORKFLOW_TASKS
  });

  // Build TLS config if certs are provided
  let tls: { clientCertPair: { crt: Buffer; key: Buffer } } | undefined;
  if (TEMPORAL_TLS_CERT && TEMPORAL_TLS_KEY) {
    log('info', 'TLS enabled — loading client certificates');
    tls = {
      clientCertPair: {
        crt: fs.readFileSync(TEMPORAL_TLS_CERT),
        key: fs.readFileSync(TEMPORAL_TLS_KEY)
      }
    };
  }

  // Create connection to Temporal server
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
    tls
  });

  log('info', 'Connected to Temporal server');

  // Resolve the path to workflow modules.
  // In production (compiled), workflows are at dist/workflows/*.js
  // The Temporal worker bundles them into a V8 isolate.
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const workflowsPath = path.resolve(__dirname, 'workflows');

  // Create the worker
  const workerOptions: WorkerOptions = {
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowsPath,
    activities: await import('./activities/index.js'),
    maxConcurrentActivityTaskExecutions: MAX_CONCURRENT_ACTIVITIES,
    maxConcurrentWorkflowTaskExecutions: MAX_CONCURRENT_WORKFLOW_TASKS
  };

  const worker = await Worker.create(workerOptions);

  log('info', 'Worker created, starting to poll for tasks');

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    log('info', `Received ${signal}, shutting down gracefully...`);
    worker.shutdown();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Run the worker — blocks until shutdown is called
  await worker.run();

  log('info', 'Worker shut down cleanly');

  // Close the connection
  await connection.close();
  log('info', 'Connection closed');
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

run().catch((err) => {
  log('error', 'Worker failed to start', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
  process.exit(1);
});
