'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Optional custom fallback UI. When omitted, the built-in error card is shown. */
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

/**
 * React class-based Error Boundary.
 *
 * Catches client-side rendering errors in its subtree, logs them, and
 * displays a friendly recovery UI with a "Try again" button.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePage />
 *   </ErrorBoundary>
 *
 * Or with a custom fallback:
 *   <ErrorBoundary fallback={<p>Oops!</p>}>
 *     <SomePage />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught rendering error:', error.message);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="card callout bad" style={{ margin: '24px auto', maxWidth: 560 }}>
          <div
            className="badge"
            style={{
              background: 'var(--pill-bad-bg)',
              color: 'var(--pill-bad)',
              border: '1px solid rgba(164, 49, 47, 0.3)',
              marginBottom: 10
            }}
          >
            Render Error
          </div>
          <h2 style={{ fontSize: 20, marginBottom: 6 }}>Something went wrong.</h2>
          <p className="muted-text">
            {this.state.error?.message ?? 'An unexpected error occurred while rendering this page.'}
          </p>
          <div className="button-row">
            <button type="button" onClick={this.handleRetry}>
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: 'transparent',
                border: '1px solid var(--line)',
                color: 'var(--ink)'
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
