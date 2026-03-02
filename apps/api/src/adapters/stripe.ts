export interface StripeAdapter {
  createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: 'succeeded' }>;
  createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: 'pending' | 'paid' }>;
}

export class FakeStripeAdapter implements StripeAdapter {
  async createTopup(agentId: string, amount: number): Promise<{ topupId: string; status: 'succeeded' }> {
    return { topupId: `topup_${agentId}_${amount}`, status: 'succeeded' };
  }

  async createPayout(agentId: string, amount: number): Promise<{ payoutId: string; status: 'pending' | 'paid' }> {
    return { payoutId: `payout_${agentId}_${amount}`, status: 'pending' };
  }
}
