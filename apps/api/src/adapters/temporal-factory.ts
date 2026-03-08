import { FakeTemporalAdapter, HttpTemporalAdapter, type WorkflowAdapter } from './temporal.js';

/**
 * TASK-HARD-004: Creates the appropriate WorkflowAdapter based on environment configuration.
 *
 * - If `TEMPORAL_ADDRESS` is set → returns HttpTemporalAdapter (real Temporal client)
 * - If `TEMPORAL_ADDRESS` is unset → returns FakeTemporalAdapter (dev/test mode)
 *
 * This ensures zero behaviour change in dev/test while enabling real Temporal
 * workflow orchestration in production by simply setting environment variables.
 */
export function createTemporalAdapter(): WorkflowAdapter {
  const address = process.env.TEMPORAL_ADDRESS;

  if (!address) {
    return new FakeTemporalAdapter();
  }

  return new HttpTemporalAdapter({
    address,
    namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE,
    tlsCertPath: process.env.TEMPORAL_TLS_CERT,
    tlsKeyPath: process.env.TEMPORAL_TLS_KEY
  });
}
