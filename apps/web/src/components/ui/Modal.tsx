/**
 * Modal på native `<dialog>` (docs/plan.md 7.11): webbläsaren sköter fokusfälla och Escape.
 * `open` styr `showModal()`/`close()`; `onClose` anropas när dialogen stängs, oavsett hur.
 * Placering `bottom` ger en bottenpanel på mobil (se BottomSheet).
 */
import { useEffect, useId, useRef, type JSX, type ReactNode, type RefObject } from 'react';

const PLACEMENT_CLASS = {
  center: '',
  bottom: 'modal-bottom sm:modal-middle',
  drawer: 'place-items-stretch justify-items-start',
} as const;

function useDialogSync(open: boolean): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return dialogRef;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  placement = 'center',
  hideTitle = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  placement?: 'center' | 'bottom' | 'drawer';
  hideTitle?: boolean;
}): JSX.Element {
  const dialogRef = useDialogSync(open);
  const titleId = useId();

  const placementClass = PLACEMENT_CLASS[placement];
  const boxClass =
    placement === 'drawer'
      ? 'modal-box h-full max-h-none w-80 max-w-[85vw] rounded-none'
      : 'modal-box';
  return (
    <dialog
      ref={dialogRef}
      className={`modal ${placementClass}`}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <div className={boxClass}>
        <h2 id={titleId} className={hideTitle ? 'sr-only' : 'mb-4'}>
          {title}
        </h2>
        {children}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" aria-label="Stäng">
          Stäng
        </button>
      </form>
    </dialog>
  );
}
