import type { AuditEvent } from '@claw/contracts';

export const KNOWN_CHANNELS = ['task.*', 'contract.*', 'dispute.*', 'wallet.*', 'sanction.*'] as const;
export type RealtimeChannel = (typeof KNOWN_CHANNELS)[number];

export function eventToChannel(event: AuditEvent): RealtimeChannel {
  const type = event.eventType;

  if (type.startsWith('task.') || type.startsWith('lease.')) {
    return 'task.*';
  }

  if (type.startsWith('contract.') || type.startsWith('milestone.') || type.startsWith('artifact.') || type.startsWith('execution.')) {
    return 'contract.*';
  }

  if (type.startsWith('dispute.')) {
    return 'dispute.*';
  }

  if (type.startsWith('wallet.') || type.startsWith('escrow.') || type.startsWith('payment.')) {
    return 'wallet.*';
  }

  return 'sanction.*';
}

export function parseChannelInput(value: string | string[] | undefined): RealtimeChannel[] {
  if (!value) {
    return [...KNOWN_CHANNELS];
  }

  const raw = Array.isArray(value) ? value.join(',') : value;
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const valid = requested.filter((item): item is RealtimeChannel => KNOWN_CHANNELS.includes(item as RealtimeChannel));
  if (valid.length === 0) {
    return [...KNOWN_CHANNELS];
  }

  return [...new Set(valid)];
}
