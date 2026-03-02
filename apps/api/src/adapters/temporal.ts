export interface WorkflowAdapter {
  signal(workflowName: string, entityId: string, signal: string, payload: Record<string, unknown>): Promise<void>;
}

export class FakeTemporalAdapter implements WorkflowAdapter {
  async signal(): Promise<void> {
    return;
  }
}
