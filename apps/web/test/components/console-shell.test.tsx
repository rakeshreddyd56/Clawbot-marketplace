import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../test-utils';
import { ConsoleShell } from '../../components/console-shell';

// Mock next/navigation for the embedded TopNav
vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/')
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}));

describe('ConsoleShell', () => {
  it('renders the page title', () => {
    render(
      <ConsoleShell title="Worker Console" subtitle="Subtitle text">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByText('Worker Console')).toBeInTheDocument();
  });

  it('renders the page subtitle', () => {
    render(
      <ConsoleShell title="Worker Console" subtitle="Bid, reserve, heartbeat flows.">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByText('Bid, reserve, heartbeat flows.')).toBeInTheDocument();
  });

  it('renders children in the main content area', () => {
    render(
      <ConsoleShell title="T" subtitle="S">
        <div data-testid="child-content">My child content</div>
      </ConsoleShell>
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
    expect(screen.getByText('My child content')).toBeInTheDocument();
  });

  it('renders the rail when provided', () => {
    render(
      <ConsoleShell title="T" subtitle="S" rail={<aside data-testid="rail-content">Rail</aside>}>
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByTestId('rail-content')).toBeInTheDocument();
  });

  it('does not render a rail aside when rail prop is omitted', () => {
    const { container } = render(
      <ConsoleShell title="T" subtitle="S">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(container.querySelector('.console-rail')).toBeNull();
  });

  it('wraps layout in a main element', () => {
    render(
      <ConsoleShell title="T" subtitle="S">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('includes TopNav (navigation element present)', () => {
    render(
      <ConsoleShell title="T" subtitle="S">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('title has page-title class', () => {
    render(
      <ConsoleShell title="My Console" subtitle="Sub">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByText('My Console')).toHaveClass('page-title');
  });

  it('subtitle has page-subtitle class', () => {
    render(
      <ConsoleShell title="T" subtitle="My subtitle text">
        <div>Content</div>
      </ConsoleShell>
    );
    expect(screen.getByText('My subtitle text')).toHaveClass('page-subtitle');
  });

  it('console-main div contains children', () => {
    const { container } = render(
      <ConsoleShell title="T" subtitle="S">
        <div data-testid="inner">Inner</div>
      </ConsoleShell>
    );
    const main = container.querySelector('.console-main');
    expect(main).toBeTruthy();
    expect(main?.querySelector('[data-testid="inner"]')).toBeTruthy();
  });

  it('console-rail aside contains the rail content', () => {
    const { container } = render(
      <ConsoleShell title="T" subtitle="S" rail={<span data-testid="rail-span">rail</span>}>
        <div>Content</div>
      </ConsoleShell>
    );
    const rail = container.querySelector('.console-rail');
    expect(rail).toBeTruthy();
    expect(rail?.querySelector('[data-testid="rail-span"]')).toBeTruthy();
  });
});
