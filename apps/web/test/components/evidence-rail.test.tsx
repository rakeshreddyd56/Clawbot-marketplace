import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EvidenceRail } from '../../components/evidence-rail';
import type { EvidenceItem } from '../../components/evidence-rail';

const baseItems: EvidenceItem[] = [
  { label: 'Inbound header', value: 'X-Moltbook-Identity', tone: 'info' },
  { label: 'Verify endpoint', value: 'POST /api/v1/agents/verify', tone: 'ok' },
  { label: 'Token lifetime', value: '60m (trusted 50m)', tone: 'warn' },
  { label: 'Hard block checks', value: 'valid + claimed + owner verified', tone: 'bad' }
];

describe('EvidenceRail', () => {
  it('renders the section title in the desktop rail', () => {
    render(<EvidenceRail title="Moltbook Reference Signals" items={baseItems} />);
    // title appears twice: desktop + mobile
    const titles = screen.getAllByText('Moltbook Reference Signals');
    expect(titles.length).toBeGreaterThanOrEqual(1);
  });

  it('renders an "Evidence" badge in desktop rail', () => {
    render(<EvidenceRail title="Test Evidence" items={baseItems} />);
    const badges = screen.getAllByText('Evidence');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('renders all item labels', () => {
    render(<EvidenceRail title="Test" items={baseItems} />);
    for (const item of baseItems) {
      expect(screen.getAllByText(item.label).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders all item values', () => {
    render(<EvidenceRail title="Test" items={baseItems} />);
    for (const item of baseItems) {
      expect(screen.getAllByText(item.value).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('applies correct pill class for tone=info', () => {
    render(<EvidenceRail title="Test" items={[{ label: 'A', value: 'val-info', tone: 'info' }]} />);
    const pills = screen.getAllByText('val-info');
    expect(pills[0]).toHaveClass('pill-info');
  });

  it('applies correct pill class for tone=ok', () => {
    render(<EvidenceRail title="Test" items={[{ label: 'B', value: 'val-ok', tone: 'ok' }]} />);
    const pills = screen.getAllByText('val-ok');
    expect(pills[0]).toHaveClass('pill-ok');
  });

  it('applies correct pill class for tone=warn', () => {
    render(<EvidenceRail title="Test" items={[{ label: 'C', value: 'val-warn', tone: 'warn' }]} />);
    const pills = screen.getAllByText('val-warn');
    expect(pills[0]).toHaveClass('pill-warn');
  });

  it('applies correct pill class for tone=bad', () => {
    render(<EvidenceRail title="Test" items={[{ label: 'D', value: 'val-bad', tone: 'bad' }]} />);
    const pills = screen.getAllByText('val-bad');
    expect(pills[0]).toHaveClass('pill-bad');
  });

  it('defaults tone to info when tone is undefined', () => {
    render(<EvidenceRail title="Test" items={[{ label: 'E', value: 'val-default' }]} />);
    const pills = screen.getAllByText('val-default');
    expect(pills[0]).toHaveClass('pill-info');
  });

  it('renders desktop rail with class desktop-rail', () => {
    const { container } = render(<EvidenceRail title="T" items={baseItems} />);
    expect(container.querySelector('.desktop-rail')).toBeTruthy();
  });

  it('renders mobile rail as a details element with class mobile-rail', () => {
    const { container } = render(<EvidenceRail title="T" items={baseItems} />);
    const mobileRail = container.querySelector('.mobile-rail');
    expect(mobileRail).toBeTruthy();
    expect(mobileRail?.tagName).toBe('DETAILS');
  });

  it('mobile rail has "Evidence" as summary text', () => {
    const { container } = render(<EvidenceRail title="T" items={baseItems} />);
    const details = container.querySelector('.mobile-rail');
    const summary = details?.querySelector('summary');
    expect(summary?.textContent).toBe('Evidence');
  });

  it('renders empty list gracefully', () => {
    render(<EvidenceRail title="Empty" items={[]} />);
    expect(screen.getAllByText('Empty').length).toBeGreaterThanOrEqual(1);
  });

  it('renders items in both desktop and mobile variants (duplicate rendering)', () => {
    render(<EvidenceRail title="T" items={[{ label: 'Label1', value: 'Value1', tone: 'ok' }]} />);
    // Each item appears in both desktop + mobile rail
    expect(screen.getAllByText('Label1').length).toBe(2);
    expect(screen.getAllByText('Value1').length).toBe(2);
  });
});
