/**
 * Gemensam testuppsättning: jest-dom, plus de webb-API:er jsdom saknar
 * (`<dialog>.showModal`, `matchMedia`, `ResizeObserver`) som komponenterna använder.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

if (typeof Reflect.get(HTMLDialogElement.prototype, 'showModal') !== 'function') {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

if (typeof Reflect.get(window, 'matchMedia') !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

globalThis.IntersectionObserver ??= class {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
};
