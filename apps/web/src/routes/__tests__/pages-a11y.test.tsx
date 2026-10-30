/**
 * Tillgänglighet per sidkomponent (docs/plan.md 7.11, vitest-axe): varje sida renderas med
 * mockade API-svar och ska sakna axe-fel i jsdom. Färgkontrast och layout kontrolleras i
 * theme-contrast.test.ts och i e2e (`a11y.spec.ts`).
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, it, vi } from 'vitest';
import * as api from '../../lib/api-client.js';
import { mockApiResponses } from '../../test/api-fixtures.js';
import { expectNoA11yViolations } from '../../test/axe.js';
import { renderWithProviders } from '../../test/render.js';
import { CheckoutCancelPage, CheckoutSuccessPage } from '../CheckoutResultPage.js';
import { EventPage } from '../EventPage.js';
import { HomePage } from '../HomePage.js';
import { MyTicketsPage } from '../MyTicketsPage.js';
import { QueuePage } from '../QueuePage.js';
import { ReservationPage } from '../ReservationPage.js';
import { SeatmapPage } from '../SeatmapPage.js';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { name: 'Sara Test', email: 'sara@example.com' },
    loginWithRedirect: vi.fn(),
    logout: vi.fn(),
    getAccessTokenSilently: () => Promise.resolve('token'),
  }),
}));
vi.mock('../../lib/auth-provider.js', () => ({ isAuth0Configured: true }));
vi.mock('../../lib/queue-token-storage.js', () => ({
  getStoredQueueToken: () => 'queue-token',
  storeQueueToken: vi.fn(),
  clearQueueToken: vi.fn(),
}));
vi.mock('../../hooks/use-queue-socket.js', () => ({ useQueueSocket: vi.fn() }));
const admission = vi.hoisted((): { status: api.QueueStatusResult } => ({
  status: { status: 'waiting', position: 12, queueDepth: 40 },
}));
vi.mock('../../hooks/use-queue-admission.js', () => ({
  useQueueAdmission: () => ({
    token: 'queue-token',
    status: admission.status,
    isJoining: false,
    error: undefined,
  }),
}));
vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api-client.js')>();
  return Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      typeof value === 'function' && key !== 'ApiError' ? vi.fn() : value,
    ]),
  );
});

beforeEach(() => {
  admission.status = { status: 'waiting', position: 12, queueDepth: 40 };
  mockApiResponses();
});

const SEATMAP_ROUTE = { route: '/events/e1/seatmap', path: '/events/:eventId/seatmap' };

async function checkPage(
  ui: React.ReactElement,
  options: { route: string; path: string },
  waitForText: string | RegExp,
): Promise<void> {
  const { container } = renderWithProviders(ui, options);
  await screen.findAllByText(waitForText);
  await expectNoA11yViolations(container);
}

describe('tillgänglighet per sida', () => {
  it('startsidan', async () => {
    await checkPage(<HomePage />, { route: '/', path: '/' }, 'Köp biljetter');
  });

  it('eventsidan', async () => {
    await checkPage(
      <EventPage />,
      { route: '/events/e1', path: '/events/:eventId' },
      'Bra att veta',
    );
  });

  it('kösidan', async () => {
    await checkPage(
      <QueuePage />,
      { route: '/events/e1/queue', path: '/events/:eventId/queue' },
      /personer köar/,
    );
  });
});

describe('tillgänglighet i bokningsflödet', () => {
  it('arenakartans översikt', async () => {
    admission.status = { status: 'admitted' };
    await checkPage(<SeatmapPage />, SEATMAP_ROUTE, 'Välj sektion');
  });

  it('sektionsvyn med stolar', async () => {
    admission.status = { status: 'admitted' };
    const { container } = renderWithProviders(<SeatmapPage />, SEATMAP_ROUTE);
    await userEvent.click(await screen.findByRole('button', { name: /^Golv, 80 kvar/ }));
    await screen.findByRole('button', { name: /Rad A, plats 1, .*ledig/ });
    await expectNoA11yViolations(container);
  });

  it('checkoutsidan', async () => {
    await checkPage(
      <ReservationPage />,
      {
        route: '/events/e1/reservations/r1',
        path: '/events/:eventId/reservations/:reservationId',
      },
      'Att betala',
    );
  });

  it('bekräftelsesidan', async () => {
    await checkPage(
      <CheckoutSuccessPage />,
      { route: '/checkout/success?event_id=e1&order_id=o1', path: '/checkout/success' },
      'Tack för ditt köp!',
    );
  });

  it('avbrytsidan', async () => {
    await checkPage(
      <CheckoutCancelPage />,
      { route: '/checkout/cancel?event_id=e1&reservation_id=r1', path: '/checkout/cancel' },
      'Försök igen',
    );
  });

  it('Mina biljetter', async () => {
    await checkPage(
      <MyTicketsPage />,
      { route: '/my-tickets', path: '/my-tickets' },
      /Visa QR-kod/,
    );
  });
});
