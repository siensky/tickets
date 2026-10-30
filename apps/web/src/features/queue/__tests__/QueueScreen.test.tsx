import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueueAdmission } from '../../../hooks/use-queue-admission.js';
import { ApiError, type QueueStatusResult } from '../../../lib/api-client.js';
import { renderWithProviders } from '../../../test/render.js';
import { expectNoA11yViolations } from '../../../test/axe.js';
import { QueueScreen } from '../QueueScreen.js';

vi.mock('../../../hooks/use-queue-admission.js', () => ({ useQueueAdmission: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

type Admission = ReturnType<typeof useQueueAdmission>;

function mockAdmission(partial: Partial<Admission>): void {
  vi.mocked(useQueueAdmission).mockReturnValue({
    token: 'tok',
    status: undefined,
    isJoining: false,
    error: undefined,
    ...partial,
  });
}

function renderScreen(onRejoin = vi.fn()): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<QueueScreen eventId="e1" onRejoin={onRejoin} />, {
    route: '/events/e1/queue',
    path: '/events/:eventId/queue',
  });
}

const waiting: QueueStatusResult = { status: 'waiting', position: 1234, queueDepth: 3400 };

beforeEach(() => vi.clearAllMocks());

describe('QueueScreen', () => {
  it('visar att den ansluter medan kötoken hämtas', () => {
    mockAdmission({ isJoining: true });
    renderScreen();
    expect(screen.getByText('Ansluter till kön…')).toBeInTheDocument();
  });

  it('visar plats och antal köande medan användaren väntar', () => {
    mockAdmission({ status: waiting });
    const { container } = renderScreen();
    expect(container.querySelector('strong')).toHaveTextContent(/1\s234/);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(/plats 1\s234/);
    expect(screen.getByText(/3\s400 personer köar/)).toBeInTheDocument();
    expect(screen.queryByText('Återansluter…')).not.toBeInTheDocument();
  });

  it('visar bannern "Återansluter…" när pollingen fallerar men behåller platsen', () => {
    mockAdmission({ status: waiting, error: new Error('nätverk') });
    const { container } = renderScreen();
    expect(screen.getByText('Återansluter…')).toBeInTheDocument();
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(/1\s234/);
  });

  it('navigerar till kartan när användaren släppts in', () => {
    mockAdmission({ status: { status: 'admitted' } });
    renderScreen();
    expect(screen.getByText('annan sida')).toBeInTheDocument();
  });
});

describe('QueueScreen, avslutade tillstånd', () => {
  it('behandlar 401 från statusanropet som utgången kötoken, inte som tappad anslutning', async () => {
    mockAdmission({
      status: waiting,
      error: new ApiError('ogiltig', 401, 'QUEUE_TOKEN_INVALID'),
    });
    const onRejoin = vi.fn();
    renderScreen(onRejoin);
    expect(screen.queryByText('Återansluter…')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ställ dig i kön igen' }));
    expect(onRejoin).toHaveBeenCalledOnce();
  });

  it('meddelar att försäljningen är stängd', () => {
    mockAdmission({ status: { status: 'sales_closed' } });
    renderScreen();
    expect(
      screen.getByText(/Försäljningen för det här evenemanget är stängd/),
    ).toBeInTheDocument();
  });

  it('erbjuder "Ställ dig i kön igen" när kötoken gått ut', async () => {
    mockAdmission({ status: { status: 'not_found' } });
    const onRejoin = vi.fn();
    renderScreen(onRejoin);
    await userEvent.click(screen.getByRole('button', { name: 'Ställ dig i kön igen' }));
    expect(onRejoin).toHaveBeenCalledOnce();
  });

  it('visar ett fel med "Försök igen" när anslutningen till kön misslyckas', async () => {
    mockAdmission({ token: undefined, error: new Error('boom') });
    const onRejoin = vi.fn();
    renderScreen(onRejoin);
    await userEvent.click(screen.getByRole('button', { name: 'Försök igen' }));
    expect(onRejoin).toHaveBeenCalledOnce();
  });

  it('saknar tillgänglighetsfel', async () => {
    mockAdmission({ status: waiting });
    const { container } = renderScreen();
    await expectNoA11yViolations(container);
  });
});
