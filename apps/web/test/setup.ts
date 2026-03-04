import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';

// ─── Global WebSocket mock ────────────────────────────────────────────────────
// Stores the latest instance so tests can trigger onmessage / onclose.
export let lastWebSocket: MockWebSocket | null = null;

export class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;

  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    lastWebSocket = this;
  }
}

// Assign to global so components can use `new WebSocket(...)`
Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
  configurable: true
});

// ─── Cleanup between tests ────────────────────────────────────────────────────
afterEach(() => {
  lastWebSocket = null;
  vi.restoreAllMocks();
});
