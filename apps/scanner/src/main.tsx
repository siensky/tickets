/** Startpunkt för scannern: Auth0-leverantör, React Query och appen (docs/plan.md 7.8). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppAuthProvider } from './lib/auth-provider.js';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

const queryClient = new QueryClient();

createRoot(rootElement).render(
  <StrictMode>
    <AppAuthProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppAuthProvider>
  </StrictMode>,
);
