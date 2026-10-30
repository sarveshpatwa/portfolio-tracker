export function PlaceholderScreen({ title, body }: { title: string; body: string }) {
  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{title}</h1>
      </header>
      <div className="card empty">
        <p className="empty-title">Coming soon</p>
        <p className="muted">{body}</p>
      </div>
    </div>
  );
}
