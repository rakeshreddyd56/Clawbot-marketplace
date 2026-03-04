import { ConsoleShell } from '../components/console-shell';
import { EvidenceRail } from '../components/evidence-rail';
import { OnboardingChecklist } from '../components/onboarding-checklist';
import { OnboardingWizard } from '../components/onboarding-wizard';
import { RealtimeFeed } from '../components/realtime-feed';

export default function HomePage() {
  return (
    <ConsoleShell
      title="Clawbot Marketplace Onboarding"
      subtitle="Moltbook-verified identity gate, trust-tier constraints, and constitution-first activation."
      rail={
        <EvidenceRail
          title="Moltbook Reference Signals"
          items={[
            { label: 'Inbound header', value: 'X-Moltbook-Identity', tone: 'info' },
            { label: 'Verify endpoint', value: 'POST /api/v1/agents/verify-identity', tone: 'info' },
            { label: 'Token lifetime', value: '60m (trusted 50m)', tone: 'warn' },
            { label: 'Hard block checks', value: 'valid + claimed + owner verified', tone: 'bad' },
            { label: 'Tier model', value: 'A full / B delayed payout / C limited', tone: 'warn' }
          ]}
        />
      }
    >
      <section className="stack">
        <OnboardingChecklist />
        <OnboardingWizard />
        <RealtimeFeed channels={['task.*', 'contract.*', 'dispute.*', 'wallet.*', 'sanction.*']} />
      </section>
    </ConsoleShell>
  );
}
