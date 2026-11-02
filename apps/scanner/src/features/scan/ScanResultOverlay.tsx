/**
 * Resultatet i helskärm (docs/plan.md 7.8): grönt för giltig biljett, rött för allt annat, med
 * ikon och text (aldrig bara färg). Visas i `RESULT_DISPLAY_MS` och ersätts sedan av kameran.
 */
import { CheckCircle2, XCircle } from 'lucide-react';
import type { JSX } from 'react';
import type { ScanResponse } from '../../lib/api-client.js';
import { formatTime } from '../../lib/format.js';

export type ScanDisplay =
  ScanResponse | { readonly result: 'error' } | { readonly result: 'auth' };

interface Message {
  readonly isOk: boolean;
  readonly title: string;
  readonly detail: string;
}

export function describeScan(display: ScanDisplay, eventTitle: string): Message {
  switch (display.result) {
    case 'ok':
      return {
        isOk: true,
        title: 'Giltig biljett',
        detail: `${eventTitle}\n${display.sectionName.length > 0 ? `${display.sectionName}, ` : ''}rad ${display.row}, plats ${display.number}`,
      };
    case 'already_scanned':
      return {
        isOk: false,
        title: 'Redan skannad',
        detail: `Redan skannad ${formatTime(display.scannedAt)} vid ${display.gate}`,
      };
    case 'not_found':
      return {
        isOk: false,
        title: 'Ogiltig biljett',
        detail: 'Biljetten gäller inte detta event eller är ogiltig',
      };
    case 'refunded':
      return {
        isOk: false,
        title: 'Återbetald',
        detail: 'Biljetten är återbetald och gäller inte',
      };
    case 'void':
      return { isOk: false, title: 'Ogiltig biljett', detail: 'Biljetten har spärrats' };
    case 'auth':
      return {
        isOk: false,
        title: 'Inloggningen gäller inte längre',
        detail: 'Tryck på "Byt event eller grind", logga ut och logga in igen.',
      };
    case 'error':
      return {
        isOk: false,
        title: 'Kunde inte kontrollera',
        detail: 'Något gick fel. Skanna biljetten igen.',
      };
  }
}

export function ScanResultOverlay({
  display,
  eventTitle,
}: {
  display: ScanDisplay;
  eventTitle: string;
}): JSX.Element {
  const { isOk, title, detail } = describeScan(display, eventTitle);
  const Icon = isOk ? CheckCircle2 : XCircle;
  return (
    <div
      role="alert"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 p-8 text-center ${
        isOk ? 'bg-success text-success-content' : 'bg-error text-error-content'
      }`}
    >
      <Icon size={96} strokeWidth={1.75} aria-hidden="true" />
      <h1 className="text-4xl">{title}</h1>
      <p className="text-xl whitespace-pre-line">{detail}</p>
    </div>
  );
}
