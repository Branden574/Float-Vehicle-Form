import { useEffect, useRef } from 'react';

export function WorkspaceDialog({
  children,
  close,
  name = 'Reservation details',
  className = 'booking-dialog',
}: {
  children: React.ReactNode;
  close: () => void;
  name?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const trigger = document.activeElement;
    d?.showModal();
    return () => {
      d?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const title = ref.current?.querySelector<HTMLElement>('h2, h3');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [name]);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={name}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}
