/** Enhetstest för AccessGate (scannern, docs/plan.md 7.8). */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessGate } from '../AccessGate.js';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  token: '',
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    isAuthenticated: auth.isAuthenticated,
    isLoading: auth.isLoading,
    loginWithRedirect: auth.loginWithRedirect,
    logout: auth.logout,
    getAccessTokenSilently: () => Promise.resolve(auth.token),
  }),
}));
vi.mock('../../../lib/auth-provider.js', () => ({ isAuth0Configured: true }));

function tokenWith(permissions: string[]): string {
  return `h.${btoa(JSON.stringify({ permissions }))}.s`;
}

function renderGate(): void {
  render(<AccessGate>{() => <p>scannern</p>}</AccessGate>);
}

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
});

describe('AccessGate', () => {
  it('ber en utloggad användare logga in', () => {
    auth.isAuthenticated = false;
    renderGate();
    expect(screen.getByRole('button', { name: 'Logga in' })).toBeInTheDocument();
  });

  it('visar "Ditt konto har inte scannerbehörighet" utan permissionen, med utloggning', async () => {
    auth.token = tokenWith([]);
    renderGate();
    expect(
      await screen.findByRole('heading', { name: 'Ditt konto har inte scannerbehörighet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logga ut' })).toBeInTheDocument();
    expect(screen.queryByText('scannern')).toBeNull();
  });

  it('släpper in personal med scan:tickets', async () => {
    auth.token = tokenWith(['scan:tickets']);
    renderGate();
    expect(await screen.findByText('scannern')).toBeInTheDocument();
  });
});
