export default function MessageSkeleton() {
  return (
    <div className="pub-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="pub-skeleton-card">
          <div className="pub-skeleton-head">
            <div className="pub-skeleton-line" style={{ width: 34, height: 34, borderRadius: 10 }} />
            <div style={{ flex: 1 }}>
              <div className="pub-skeleton-line" style={{ width: "32%", margin: 0 }} />
              <div className="pub-skeleton-line" style={{ width: "18%" }} />
            </div>
          </div>
          <div className="pub-skeleton-line" style={{ width: "94%" }} />
          <div className="pub-skeleton-line" style={{ width: "86%" }} />
          <div className="pub-skeleton-line" style={{ width: "62%" }} />
        </div>
      ))}
    </div>
  );
}
