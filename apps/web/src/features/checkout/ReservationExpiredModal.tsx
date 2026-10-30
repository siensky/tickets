/** "Tiden gick ut — platserna är släppta" (docs/plan.md 7.11 UI-tillstånd). */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';

export function ReservationExpiredModal({
  open,
  eventId,
}: {
  open: boolean;
  eventId: string;
}): JSX.Element {
  const navigate = useNavigate();
  const goToMap = (): void => void navigate(`/events/${eventId}/seatmap`);
  return (
    <Modal open={open} onClose={goToMap} title="Tiden gick ut">
      <p className="mb-6">Tiden gick ut — platserna är släppta.</p>
      <Button onClick={goToMap}>Välj nya platser</Button>
    </Modal>
  );
}
