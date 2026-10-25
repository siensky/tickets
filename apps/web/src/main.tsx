import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AppAuthProvider } from './lib/auth-provider.js';
import { queryClient } from './lib/query-client.js';
import { registerServiceWorker } from './lib/service-worker-registration.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AppAuthProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AppAuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

registerServiceWorker();
