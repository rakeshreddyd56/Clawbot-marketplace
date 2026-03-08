export default function NotFound() {
  return (
    <main id="main-content" style={{ padding: 40, textAlign: 'center' }}>
      <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ fontSize: 48, marginBottom: 8 }}>404</h1>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>Page Not Found</h2>
        <p className="muted-text" style={{ marginBottom: 20 }}>
          The page you are looking for does not exist or has been moved.
        </p>
        <a href="/" style={{ display: 'inline-block' }}>
          <button type="button">Back to Console</button>
        </a>
      </div>
    </main>
  );
}
