import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal built on the native <dialog> element: focus trapping, Esc to close
 * and the backdrop come from the browser (Safari 15.4+, all modern browsers).
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 id="dialog-title" className="dialog-title">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
