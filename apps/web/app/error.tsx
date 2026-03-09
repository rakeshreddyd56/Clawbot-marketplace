'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main-content" style={{ padding: 40, textAlign: 'center' }}>
      <div
        className="card"
        style={{ maxWidth: 480, margin: '0 auto' }}
      >
        <h1 style={{ fontSize: 48, marginBottom: 8 }}>Error</h1>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>Something went wrong</h2>
        <p className="muted-text" style={{ marginBottom: 20 }}>
          An unexpected error occurred. Please try again.
        </p>
        {error.digest && (
          <p style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
            Error ID: {error.digest}
          </p>
        )}
        <button type="button" onClick={reset}>
          Try Again
        </button>
      </div>
    </main>
  );
}
