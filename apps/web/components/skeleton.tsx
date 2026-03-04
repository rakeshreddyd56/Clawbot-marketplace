/**
 * Skeleton loading placeholders — use these to replace boolean loading states
 * in console pages so the layout doesn't shift while data is fetching.
 *
 * CSS is defined in globals.css under the "Skeleton loaders" section.
 */

type SkeletonLineProps = {
  /** Width as a CSS value string (e.g. "60%", "120px") or a pixel number. */
  width?: string | number;
  /** Height in pixels. */
  height?: number;
};

/** A single animated shimmer line. */
export function SkeletonLine({ width = '100%', height = 16 }: SkeletonLineProps) {
  return (
    <div
      className="skeleton-line"
      aria-hidden="true"
      style={{ width: typeof width === 'number' ? `${width}px` : width, height }}
    />
  );
}

/** A card-shaped skeleton with a header chip and stacked body lines. */
export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card" aria-hidden="true" aria-busy="true">
      <SkeletonLine width="38%" height={13} />
      <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonLine key={i} width={`${95 - i * 12}%`} />
        ))}
      </div>
    </div>
  );
}

/**
 * A vertical list of skeleton rows — mirrors the `.readiness-row` pattern
 * used in onboarding checklist and task list cards.
 */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="stack-tight" aria-hidden="true" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '9px 10px',
            background: '#fff',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8
          }}
        >
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <SkeletonLine width="55%" height={14} />
            <SkeletonLine width="35%" height={12} />
          </div>
          <SkeletonLine width={56} height={22} />
        </div>
      ))}
    </div>
  );
}
