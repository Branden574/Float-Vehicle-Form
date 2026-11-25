import { useEffect, useRef } from 'react';

export function WorkspaceDialog({
  children,
  close,
  name = 'Reservation details',
  step = name,
  className = 'booking-dialog',
}: {
  children: React.ReactNode;
  close: () => void;
  name?: string;
  step?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousStep = useRef(step);
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
    const dialog = ref.current;
    if (!dialog) return;
    const destination =
      previousStep.current !== step ? dialog.querySelector<HTMLElement>('[data-step-focus]') : null;
    previousStep.current = step;
    const heading = destination || dialog.querySelector<HTMLElement>('h2, h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      if (destination) destination.scrollIntoView({ block: 'start' });
      else dialog.scrollTop = 0;
    }
  }, [step]);
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
