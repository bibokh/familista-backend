// The WebSocket servers this process actually mounted
// ─────────────────────────────────────────────────────────────────────────────
// `server.ts` mounts the match and market WebSocket servers on the HTTP server
// at boot. Each mount registers here, so the health layer reads the servers
// that exist rather than assuming they do: how many are mounted, how many
// clients each holds right now, and every `error` either server or any of its
// sockets emitted — counted through the outcome meter, so a burst of socket
// errors is judged in the same window as every other dependency.

import type { WebSocketServer } from 'ws';
import { recordOutcome } from './outcome-meter';

export const WS_CHANNEL = 'websockets';

const servers = new Map<string, WebSocketServer>();

export function registerWebSocketServer(name: string, wss: WebSocketServer): void {
  servers.set(name, wss);
  wss.on('error', () => recordOutcome(WS_CHANNEL, false));
  wss.on('connection', (socket) => {
    recordOutcome(WS_CHANNEL, true);
    socket.on('error', () => recordOutcome(WS_CHANNEL, false));
  });
}

export function webSocketServers(): { name: string; clients: number }[] {
  return [...servers.entries()].map(([name, wss]) => ({ name, clients: wss.clients.size }));
}

/** Forget every registration. Tests only. */
export function resetWebSocketRegistry(): void { servers.clear(); }
