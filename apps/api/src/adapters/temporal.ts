/**
 * TASK-HARD-004: Temporal workflow adapter for production workflow orchestration.
 *
 * Provides two implementations of the WorkflowAdapter interface:
 * - FakeTemporalAdapter: no-op for dev/test (no Temporal server needed)
 * - HttpTemporalAdapter: real @temporalio/client for production
 *
 * The adapter supports:
 * - Starting new workflows (startWorkflow)
 * - Sending signals to running workflows (signal)
 * - Querying workflow state (query)
 *
 * Environment-based selection happens in temporal-factory.ts.
 */

import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import * as fs from 'node:fs';

// ─── Interface ──────────────────────────────────────────────────────────────────

export interface WorkflowAdapter {
  /**
   * Send a signal to a running workflow.
   *
   * @param workflowName - The workflow type name (e.g. 'taskLifecycleWorkflow')
   * @param entityId - The workflow ID (entity correlation ID)
   * @param signal - The signal name (e.g. 'reserve', 'accept')
   * @param payload - Signal payload data
   */
  signal(workflowName: string, entityId: string, signal: string, payload: Record<string, unknown>): Promise<void>;

  /**
   * Start a new workflow execution.
   *
   * @param workflowName - The workflow type name
   * @param workflowId - Unique workflow ID (typically entity ID)
   * @param args - Arguments passed to the workflow function
   * @returns The workflow ID of the started execution
   */
  startWorkflow(workflowName: string, workflowId: string, args: unknown[]): Promise<string>;

  /**
   * Query a running workflow's state.
   *
   * @param workflowId - The workflow ID to query
   * @param queryName - The query type name
   * @returns The query result
   */
  query<T = unknown>(workflowId: string, queryName: string): Promise<T>;
}

// ─── Fake Adapter (dev/test) ─────────────────────────────────────────────────

export class FakeTemporalAdapter implements WorkflowAdapter {
  /** In-memory log of signals for testing */
  readonly signalLog: Array<{
    workflowName: string;
    entityId: string;
    signal: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }> = [];

  /** In-memory log of started workflows for testing */
  readonly startLog: Array<{
    workflowName: string;
    workflowId: string;
    args: unknown[];
    timestamp: string;
  }> = [];

  async signal(
    workflowName: string,
    entityId: string,
    signal: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.signalLog.push({
      workflowName,
      entityId,
      signal,
      payload,
      timestamp: new Date().toISOString()
    });
  }

  async startWorkflow(
    workflowName: string,
    workflowId: string,
    args: unknown[]
  ): Promise<string> {
    this.startLog.push({
      workflowName,
      workflowId,
      args,
      timestamp: new Date().toISOString()
    });
    return workflowId;
  }

  async query<T = unknown>(_workflowId: string, _queryName: string): Promise<T> {
    return undefined as T;
  }
}

// ─── Real Temporal Adapter (production) ──────────────────────────────────────

export interface HttpTemporalAdapterOptions {
  address: string;
  namespace?: string;
  taskQueue?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

/**
 * Real Temporal client adapter for production use.
 *
 * Connects to a Temporal server (local or Temporal Cloud) and provides
 * workflow start, signal, and query capabilities via @temporalio/client.
 *
 * Connection is established lazily on first use and cached for reuse.
 * Supports mTLS for encrypted communication with Temporal Cloud.
 */
export class HttpTemporalAdapter implements WorkflowAdapter {
  private readonly address: string;
  private readonly namespace: string;
  private readonly taskQueue: string;
  private readonly tlsCertPath?: string;
  private readonly tlsKeyPath?: string;

  /** Lazy-initialized Temporal client */
  private _client: Client | null = null;
  private _connection: Connection | null = null;
  private _connecting: Promise<Client> | null = null;

  constructor(opts: HttpTemporalAdapterOptions) {
    this.address = opts.address;
    this.namespace = opts.namespace ?? 'default';
    this.taskQueue = opts.taskQueue ?? 'marketplace-event';
    this.tlsCertPath = opts.tlsCertPath;
    this.tlsKeyPath = opts.tlsKeyPath;
  }

  /**
   * Get or create the Temporal client.
   * Uses lazy initialization so the connection is only established on first use.
   * Handles concurrent initialization safely via a connecting promise.
   */
  private async getClient(): Promise<Client> {
    if (this._client) return this._client;

    // Prevent multiple concurrent connection attempts
    if (this._connecting) return this._connecting;

    this._connecting = this.connect();
    try {
      this._client = await this._connecting;
      return this._client;
    } finally {
      this._connecting = null;
    }
  }

  private async connect(): Promise<Client> {
    // Build TLS config if cert paths are provided (for Temporal Cloud mTLS)
    let tls: { clientCertPair: { crt: Buffer; key: Buffer } } | undefined;
    if (this.tlsCertPath && this.tlsKeyPath) {
      tls = {
        clientCertPair: {
          crt: fs.readFileSync(this.tlsCertPath),
          key: fs.readFileSync(this.tlsKeyPath)
        }
      };
    }

    this._connection = await Connection.connect({
      address: this.address,
      tls
    });

    return new Client({
      connection: this._connection,
      namespace: this.namespace
    });
  }

  /**
   * Send a signal to a running workflow.
   *
   * Uses getHandle() to reference the workflow by its ID, then calls signal().
   * If the workflow doesn't exist, Temporal will throw a WorkflowNotFoundError.
   */
  async signal(
    _workflowName: string,
    entityId: string,
    signal: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const client = await this.getClient();
    const handle: WorkflowHandle = client.workflow.getHandle(entityId);
    await handle.signal(signal, payload);
  }

  /**
   * Start a new workflow execution.
   *
   * Uses client.workflow.start() which is idempotent if the workflow ID already exists
   * (returns the existing handle). The workflowName is used as the workflow type.
   */
  async startWorkflow(
    workflowName: string,
    workflowId: string,
    args: unknown[]
  ): Promise<string> {
    const client = await this.getClient();
    const handle = await client.workflow.start(workflowName, {
      taskQueue: this.taskQueue,
      workflowId,
      args
    });
    return handle.workflowId;
  }

  /**
   * Query a running workflow's state.
   *
   * Returns the result of the named query handler registered in the workflow.
   */
  async query<T = unknown>(workflowId: string, queryName: string): Promise<T> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(workflowId);
    return await handle.query(queryName) as T;
  }

  /**
   * Gracefully close the Temporal connection.
   * Call this during application shutdown.
   */
  async close(): Promise<void> {
    if (this._connection) {
      await this._connection.close();
      this._connection = null;
      this._client = null;
    }
  }
}
