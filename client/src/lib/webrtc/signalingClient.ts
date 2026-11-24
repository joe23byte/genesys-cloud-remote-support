import { io, type Socket } from 'socket.io-client';

export type AckResult<T> = { ok: true; data?: T } | { ok: false; error: string };

export interface SignalLogEntry {
  ts: number;
  direction: 'in' | 'out' | 'local';
  event: string;
  detail?: string;
}

/**
 * Thin wrapper around Socket.IO. Uses WebSocket first (WSS on HTTPS pages) and falls
 * back to long polling for proxies that block WebSockets. No cookies are involved.
 */
export function connectSignaling(role: 'agent' | 'customer', token: string): Socket {
  return io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    withCredentials: false,
    auth: { role, token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });
}

export function emitWithAck<T>(socket: Socket, event: string, payload?: unknown, timeoutMs = 8000): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload ?? {}, (err: Error | null, response: AckResult<T>) => {
      if (err) resolve({ ok: false, error: 'timeout' });
      else resolve(response ?? { ok: false, error: 'no_response' });
    });
  });
}

export function randomPcId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short, SDP-free description of a signal for the debug log. */
export function describeSignal(msg: { kind: string; pcId: string; candidate?: { candidate: string } }): string {
  if (msg.kind === 'candidate' && msg.candidate) {
    const typ = / typ (\w+)/.exec(msg.candidate.candidate)?.[1] ?? '?';
    const proto = / (udp|tcp) /i.exec(msg.candidate.candidate)?.[1]?.toLowerCase() ?? '?';
    return `candidate ${typ}/${proto} pc=${msg.pcId.slice(0, 6)}`;
  }
  return `${msg.kind} pc=${msg.pcId.slice(0, 6)}`;
}
