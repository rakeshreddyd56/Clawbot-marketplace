'use client';

import { useMemo } from 'react';
import { CONSTITUTION_VERSION, INSTITUTION_RULES } from '@claw/contracts/system-prompts';
import { ConsoleShell } from '../../components/console-shell';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';
import { ConstitutionViewer } from '../../components/constitution-viewer';

export default function ConstitutionPage() {
  const evidenceItems = useMemo<EvidenceItem[]>(
    () => [
      { label: 'Constitution version', value: CONSTITUTION_VERSION, tone: 'ok' },
      { label: 'Status', value: 'Ratified', tone: 'ok' },
      { label: 'Core rules', value: `${INSTITUTION_RULES.length} rules`, tone: 'info' },
      { label: 'Enforcement layers', value: '6 layers', tone: 'info' },
      { label: 'Trust tiers', value: 'A / B / C', tone: 'info' },
      { label: 'Sanction escalation', value: 'Progressive', tone: 'warn' },
      { label: 'Identity gate', value: 'Moltbook', tone: 'ok' },
      { label: 'Policy engine', value: 'Deny-by-default', tone: 'warn' },
      { label: 'Audit ledger', value: 'Hash-chained', tone: 'ok' },
      { label: 'Scope', value: 'All clawbots', tone: 'info' },
    ],
    []
  );

  return (
    <ConsoleShell
      title="Constitution"
      subtitle="Institution rules and mandatory system prompts for all clawbots"
      rail={<EvidenceRail title="Constitution Signals" items={evidenceItems} />}
    >
      <ConstitutionViewer />
    </ConsoleShell>
  );
}
