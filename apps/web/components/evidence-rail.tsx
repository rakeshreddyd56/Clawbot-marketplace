export type EvidenceItem = {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
};

export function EvidenceRail({ title, items }: { title: string; items: EvidenceItem[] }) {
  return (
    <>
      <div className="card evidence-panel desktop-rail">
        <div className="badge">Evidence</div>
        <h3>{title}</h3>
        <div className="evidence-list">
          {items.map((item) => (
            <div key={`${item.label}-${item.value}`} className="evidence-item">
              <div className="evidence-key">{item.label}</div>
              <div className={`pill pill-${item.tone ?? 'info'}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <details className="card evidence-panel mobile-rail">
        <summary>Evidence</summary>
        <h3>{title}</h3>
        <div className="evidence-list">
          {items.map((item) => (
            <div key={`${item.label}-${item.value}`} className="evidence-item">
              <div className="evidence-key">{item.label}</div>
              <div className={`pill pill-${item.tone ?? 'info'}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
