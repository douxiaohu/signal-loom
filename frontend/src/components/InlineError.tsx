export default function InlineError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <div className="inline-error"><div><strong>{title}</strong><p>{message}</p></div><button type="button" onClick={onRetry}><span className="refresh-mark" aria-hidden="true" />就地重试</button></div>;
}
