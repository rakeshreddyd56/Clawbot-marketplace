'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main id="main-content" style={{ padding: 40, textAlign: 'center' }}>
          <div
            style={{
              maxWidth: 480,
              margin: '0 auto',
              padding: 32,
              border: '1px solid #e0e0e0',
              borderRadius: 8,
            }}
          >
            <h1 style={{ fontSize: 48, marginBottom: 8 }}>500</h1>
            <h2 style={{ fontSize: 20, marginBottom: 12 }}>Something went wrong</h2>
            <p style={{ color: '#666', marginBottom: 20 }}>
              An unexpected error occurred. Please try again.
            </p>
            {error.digest && (
              <p style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
                Error ID: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '8px 24px',
                cursor: 'pointer',
                borderRadius: 4,
                border: '1px solid #333',
                background: '#333',
                color: '#fff',
              }}
            >
              Try Again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
