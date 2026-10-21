/**
 * Public entrypoint for @tickets/domain. Re-exports everything other
 * services and shared packages are allowed to import from here — keep
 * this file as the single barrel so consumers never reach into
 * subdirectories directly.
 */
export * from './errors.js';
export * from './outbox.js';
