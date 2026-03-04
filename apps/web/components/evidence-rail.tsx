export type EvidenceItem = {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
};

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  return (
    <div className="evidence-list">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="evidence-item">
          <div className="evidence-key">{item.label}</div>
          <div className={`pill pill-${item.tone ?? 'info'}`} role="status" aria-label={`${item.label}: ${item.value}`}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function EvidenceRail({ title, items }: { title: string; items: EvidenceItem[] }) {
  return (
    <>
      <div className="card evidence-panel desktop-rail" aria-label={title}>
        <div className="badge" aria-hidden="true">Evidence</div>
        <h2>{title}</h2>
        <EvidenceList items={items} />
      </div>

      <details className="card evidence-panel mobile-rail">
        <summary>Evidence: {title}</summary>
        <EvidenceList items={items} />
      </details>
    </>
  );
}
