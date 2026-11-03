import { describe, expect, it } from 'vitest';
import {
  watchForNewVersion,
  type ServiceWorkerTakeoverSource,
} from '../service-worker-registration.js';

function fakeSource(controller: unknown): {
  source: ServiceWorkerTakeoverSource;
  takeOver: () => void;
} {
  const listeners: (() => void)[] = [];
  const source: ServiceWorkerTakeoverSource = {
    controller,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
  return { source, takeOver: () => listeners.forEach((listener) => listener()) };
}

describe('watchForNewVersion', () => {
  it('rapporterar en ny version när den tar över en sida som redan styrdes av en äldre', () => {
    const { source, takeOver } = fakeSource({});
    const isReady = watchForNewVersion(source);

    expect(isReady()).toBe(false);
    takeOver();
    expect(isReady()).toBe(true);
  });

  it('rapporterar inte första installationen, men väl en senare version i samma flik', () => {
    const { source, takeOver } = fakeSource(null);
    const isReady = watchForNewVersion(source);

    takeOver();
    expect(isReady()).toBe(false);

    takeOver();
    expect(isReady()).toBe(true);
  });
});
