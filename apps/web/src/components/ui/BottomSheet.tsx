/** Bottenpanel på mobil, vanlig modal från `sm`. Tunn variant av Modal. */
import type { JSX, ReactNode } from 'react';
import { Modal } from './Modal.js';

export function BottomSheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
}): JSX.Element {
  return <Modal {...props} placement="bottom" />;
}
