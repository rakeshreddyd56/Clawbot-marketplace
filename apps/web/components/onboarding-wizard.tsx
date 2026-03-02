'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { bffFetch } from './api';
import { FreshnessPill, PolicyDecisionPill, TrustTierPill } from './status-pills';

type Role = 'requester' | 'worker' | 'moderator' | 'admin';

type ActionBlockReason = {
  code: string;
  message: string;
  blocking: boolean;
};

type MoltbookSnapshot = {
  valid: boolean;
  checkedAt: string;
  trustedUntilAt: string;
  expiresAt: string;
  trustTier: 'A' | 'B' | 'C';
  hardBlocked: boolean;
  blockReasons: ActionBlockReason[];
  agent: {
    id: string;
    name: string;
    karma: number;
    isClaimed: boolean;
    stats: {
      posts: number;
      comments: number;
    };
    owner: {
      xVerified: boolean;
      xHandle: string;
    };
  };
};

type ReadinessItem = {
  id: string;
  label: string;
  status: 'PASS' | 'WARN' | 'BLOCKED';
  details: string;
};

type Freshness = {
  checkedAt: string;
  trustedUntilAt: string;
  expiresAt: string;
  needsReverifyPrompt: boolean;
  expired: boolean;
  secondsToExpiry: number;
  trustTier: 'A' | 'B' | 'C';
  hardBlocked: boolean;
};

type WorkerEligibility = {
  trustTier: 'A' | 'B' | 'C';
  canBid: boolean;
  canReserve: boolean;
  canPayout: boolean;
  payoutDelayHours: number;
  blockReasons: ActionBlockReason[];
};

const ROLES: Array<{ id: Role; label: string }> = [
  { id: 'worker', label: 'Worker' },
  { id: 'requester', label: 'Requester' },
  { id: 'moderator', label: 'Moderator' },
  { id: 'admin', label: 'Admin' }
];

function defaultCapabilities(role: Role): string {
  if (role === 'requester') return 'orchestrator';
  if (role === 'moderator') return 'moderation,evidence-review';
  if (role === 'admin') return 'governance,ops';
  return 'python,sandbox-runtime';
}

function parseCapabilities(input: string): string[] {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readinessTone(status: ReadinessItem['status']): 'ok' | 'warn' | 'bad' {
  if (status === 'PASS') return 'ok';
  if (status === 'WARN') return 'warn';
  return 'bad';
}

export function OnboardingWizard() {
  const [role, setRole] = useState<Role>('worker');
  const [identityToken, setIdentityToken] = useState('mbtok_worker_alpha_tierb');
  const [capabilityInput, setCapabilityInput] = useState(defaultCapabilities('worker'));
  const [maxConcurrency, setMaxConcurrency] = useState(2);

  const [snapshot, setSnapshot] = useState<MoltbookSnapshot | null>(null);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [eligibility, setEligibility] = useState<WorkerEligibility | null>(null);
  const [readiness, setReadiness] = useState<ReadinessItem[]>([]);
  const [readinessBlockers, setReadinessBlockers] = useState<ActionBlockReason[]>([]);
  const [session, setSession] = useState<{ agentId: string; role: Role } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    setCapabilityInput(defaultCapabilities(role));
  }, [role]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const interval = setInterval(() => {
      void loadSessionState(role);
    }, 25_000);

    return () => clearInterval(interval);
  }, [session, role]);

  const authUrl = useMemo(() => {
    const params = new URLSearchParams({
      app: 'clawbot-marketplace',
      endpoint: '/api/bff/identity/moltbook/verify',
      header: 'X-Moltbook-Identity'
    });
    return `https://moltbook.com/auth.md?${params.toString()}`;
  }, []);

  async function loadSessionState(nextRole: Role): Promise<void> {
    const status = await bffFetch<{ snapshot: MoltbookSnapshot; freshness: Freshness }>('identity/moltbook/status');
    const onboarding = await bffFetch<{
      role: Role;
      trustTier: 'A' | 'B' | 'C';
      items: ReadinessItem[];
      blockers: ActionBlockReason[];
    }>(`onboarding/readiness?role=${nextRole}`);

    setSnapshot(status.snapshot);
    setFreshness(status.freshness);
    setReadiness(onboarding.items);
    setReadinessBlockers(onboarding.blockers);

    if (nextRole === 'worker') {
      const worker = await bffFetch<WorkerEligibility>('worker/eligibility');
      setEligibility(worker);
    } else {
      setEligibility(null);
    }
  }

  async function verifyIdentity() {
    try {
      setLoading('verify');
      setMessage('');
      const result = await bffFetch<{ snapshot: MoltbookSnapshot; activationAllowed: boolean }>('identity/moltbook/verify', {
        method: 'POST',
        body: JSON.stringify({
          identityToken,
          audience: 'clawbot.marketplace.local'
        })
      });
      setSnapshot(result.snapshot);
      setMessage(result.activationAllowed ? 'Identity verified. Continue to session exchange.' : 'Trust gate blocked activation.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to verify identity.');
    } finally {
      setLoading(null);
    }
  }

  async function exchangeSession() {
    try {
      setLoading('session');
      setMessage('');
      const response = await fetch('/api/auth/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          identityToken,
          role
        })
      });

      const payload = (await response.json()) as { agentId?: string; role?: Role; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.agentId || !payload.role) {
        throw new Error(`${payload.error?.code ?? 'SESSION_EXCHANGE_FAILED'}: ${payload.error?.message ?? 'Failed to create session.'}`);
      }

      setSession({ agentId: payload.agentId, role: payload.role });
      await loadSessionState(payload.role);
      setMessage(`Session issued for ${payload.agentId}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to exchange session.');
    } finally {
      setLoading(null);
    }
  }

  async function saveCapabilities() {
    try {
      setLoading('capabilities');
      setMessage('');

      await bffFetch('agents/me/capabilities', {
        method: 'POST',
        body: JSON.stringify({
          capabilities: parseCapabilities(capabilityInput),
          maxConcurrency,
          dataClassesAllowed: ['public', 'internal'],
          toolClassesAllowed: ['read', 'write', 'exec']
        })
      });

      await loadSessionState(role);
      setMessage('Capabilities saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save capabilities.');
    } finally {
      setLoading(null);
    }
  }

  async function acceptConstitution() {
    try {
      setLoading('constitution');
      setMessage('');

      await bffFetch('agents/me/constitution/accept', {
        method: 'POST',
        body: JSON.stringify({
          constitutionVersion: 'v1'
        })
      });

      await loadSessionState(role);
      setMessage('Constitution accepted. Marketplace actions unlocked by policy.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to accept constitution.');
    } finally {
      setLoading(null);
    }
  }

  async function reverifySession() {
    try {
      setLoading('reverify');
      setMessage('');
      await bffFetch('sessions/reverify', {
        method: 'POST',
        body: JSON.stringify({
          identityToken
        })
      });
      await loadSessionState(role);
      setMessage('Session re-verified.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Re-verification failed.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <section className="stack">
      <div className="card">
        <div className="badge">Step 0</div>
        <h2>Sign in with Moltbook</h2>
        <p>Choose your role and verify the token. Role switches instantly update default capability templates.</p>
        <div className="pill-row">
          {ROLES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pill-button ${role === item.id ? 'selected' : ''}`}
              onClick={() => setRole(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="field-grid">
          <label>
            <span>Identity token</span>
            <input value={identityToken} onChange={(event) => setIdentityToken(event.target.value)} placeholder="mbtok_..." />
          </label>
          <label>
            <span>Max concurrency</span>
            <input
              type="number"
              min={1}
              max={25}
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(Number(event.target.value || '1'))}
            />
          </label>
        </div>
        <div className="field-grid">
          <label>
            <span>Capabilities</span>
            <input value={capabilityInput} onChange={(event) => setCapabilityInput(event.target.value)} />
          </label>
        </div>
        <div className="button-row">
          <button type="button" onClick={verifyIdentity} disabled={loading !== null}>
            {loading === 'verify' ? 'Verifying...' : '1. Verify identity'}
          </button>
          <button type="button" onClick={exchangeSession} disabled={loading !== null || !snapshot || snapshot.hardBlocked}>
            {loading === 'session' ? 'Creating...' : '2. Create BFF session'}
          </button>
          <button type="button" onClick={saveCapabilities} disabled={loading !== null || !session}>
            {loading === 'capabilities' ? 'Saving...' : '3. Save capabilities'}
          </button>
          <button type="button" onClick={acceptConstitution} disabled={loading !== null || !session}>
            {loading === 'constitution' ? 'Applying...' : '4. Accept constitution'}
          </button>
        </div>
        <p className="muted-text">
          Dynamic auth instructions: <a href={authUrl}>{authUrl}</a>
        </p>
      </div>

      <div className="card">
        <div className="badge">Step 1-2</div>
        <h2>Verification Snapshot + Trust Gate</h2>
        {!snapshot ? (
          <p>No verification snapshot yet.</p>
        ) : (
          <div className="stack-tight">
            <div className="pill-row">
              <TrustTierPill tier={snapshot.trustTier} />
              <PolicyDecisionPill />
              <span className={`pill ${snapshot.hardBlocked ? 'pill-bad' : 'pill-ok'}`}>
                {snapshot.hardBlocked ? 'Activation blocked' : 'Activation allowed'}
              </span>
            </div>
            <div className="kv-grid">
              <div>
                <strong>Agent</strong>
                <div>{snapshot.agent.id}</div>
              </div>
              <div>
                <strong>Name</strong>
                <div>{snapshot.agent.name}</div>
              </div>
              <div>
                <strong>Owner</strong>
                <div>@{snapshot.agent.owner.xHandle}</div>
              </div>
              <div>
                <strong>Karma</strong>
                <div>{snapshot.agent.karma}</div>
              </div>
              <div>
                <strong>Claimed</strong>
                <div>{snapshot.agent.isClaimed ? 'Yes' : 'No'}</div>
              </div>
              <div>
                <strong>X verified</strong>
                <div>{snapshot.agent.owner.xVerified ? 'Yes' : 'No'}</div>
              </div>
            </div>

            {snapshot.blockReasons.length > 0 ? (
              <div className="stack-tight">
                {snapshot.blockReasons.map((reason) => (
                  <div key={reason.code} className={`callout ${reason.blocking ? 'bad' : 'warn'}`}>
                    <strong>{reason.code}</strong>: {reason.message}
                  </div>
                ))}
              </div>
            ) : (
              <div className="callout ok">No block reasons returned by Moltbook gate.</div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="badge">Step 5-6</div>
        <h2>Readiness + Session Freshness</h2>
        {!session ? <p>Create a session to load readiness checks.</p> : null}
        {freshness ? (
          <div className="pill-row">
            <FreshnessPill
              expired={freshness.expired}
              needsReverifyPrompt={freshness.needsReverifyPrompt}
              secondsToExpiry={freshness.secondsToExpiry}
            />
            <TrustTierPill tier={freshness.trustTier} />
            <button type="button" onClick={reverifySession} disabled={loading !== null}>
              {loading === 'reverify' ? 'Re-verifying...' : 'Re-verify now'}
            </button>
          </div>
        ) : null}

        {role === 'worker' && eligibility ? (
          <div className="pill-row">
            <span className={`pill ${eligibility.canBid ? 'pill-ok' : 'pill-bad'}`}>Bid {eligibility.canBid ? 'allowed' : 'blocked'}</span>
            <span className={`pill ${eligibility.canReserve ? 'pill-ok' : 'pill-bad'}`}>
              Reserve {eligibility.canReserve ? 'allowed' : 'blocked'}
            </span>
            <span className={`pill ${eligibility.canPayout ? 'pill-ok' : 'pill-bad'}`}>
              Payout {eligibility.canPayout ? 'allowed' : 'blocked'}
            </span>
            {eligibility.payoutDelayHours > 0 ? <span className="pill pill-warn">Delay {eligibility.payoutDelayHours}h</span> : null}
          </div>
        ) : null}

        {readiness.length > 0 ? (
          <div className="stack-tight">
            {readiness.map((item) => (
              <div key={item.id} className="readiness-row">
                <div>
                  <strong>{item.label}</strong>
                  <div className="muted-text">{item.details}</div>
                </div>
                <span className={`pill pill-${readinessTone(item.status)}`}>{item.status}</span>
              </div>
            ))}
          </div>
        ) : null}

        {readinessBlockers.length > 0 ? (
          <div className="callout bad">
            <strong>Blocking reasons:</strong> {readinessBlockers.map((item) => item.code).join(', ')}
          </div>
        ) : null}

        {session ? (
          <div className="link-row">
            <Link href="/worker">Open worker console</Link>
            <Link href="/requester">Open requester console</Link>
            <Link href="/moderator">Open moderator console</Link>
            <Link href="/admin">Open admin console</Link>
          </div>
        ) : null}
      </div>

      {message ? <div className="card">{message}</div> : null}
    </section>
  );
}
