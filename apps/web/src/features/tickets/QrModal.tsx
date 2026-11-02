/** QR-koden i helskärmsvänlig modal på vit bakgrund, så att skannern får max kontrast. */
import { QRCodeSVG } from 'qrcode.react';
import type { JSX } from 'react';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';

export function QrModal({
  open,
  onClose,
  title,
  caption,
  qrToken,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  caption: string;
  qrToken: string;
}): JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {/* ph-no-capture: QR-koden spelas aldrig in (docs/plan.md 8.4) */}
      <div className="ph-no-capture flex flex-col items-center gap-4">
        <div className="rounded-box bg-white p-4">
          <QRCodeSVG
            value={qrToken}
            size={280}
            level="M"
            role="img"
            aria-label={`QR-kod för ${caption}`}
          />
        </div>
        <p className="text-center font-medium">{caption}</p>
        <Button variant="secondary" className="w-full" onClick={onClose}>
          Stäng
        </Button>
      </div>
    </Modal>
  );
}
