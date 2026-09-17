import type { Toast } from '@/hooks/useToasts';

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast-item">
          {t.texto}
        </div>
      ))}
    </div>
  );
}
