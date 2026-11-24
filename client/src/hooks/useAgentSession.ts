import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type IceConfig, type LiveSessionState, type SessionView } from '../../../shared/protocol';
import { agentToken } from '../lib/api';
import { AgentPeer } from '../lib/webrtc/agentPeer';
import { connectSignaling, emitWithAck, type SignalLogEntry } from '../lib/webrtc/signalingClient';
import type { StatsSnapshot } from '../lib/webrtc/stats';

export type SocketState = 'connecting' | 'online' | 'reconnecting' | 'replaced' | 'unauthorized' | 'ended' | 'error';

export interface AgentSessionState {
  socketState: SocketState;
  session: SessionView | null;
  live: LiveSessionState | null;
  stream: MediaStream | null;
  pcState: RTCPeerConnectionState | 'idle';
  stats: StatsSnapshot | null;
  iceConfig: IceConfig | null;
  log: SignalLogEntry[];
  error: string | null;
}

export function useAgentSession(sessionId: string): AgentSessionState & { setSession: (s: SessionView) => void } {
  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [session, setSession] = useState<SessionView | null>(null);
  const [live, setLive] = useState<LiveSessionState | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pcState, setPcState] = useState<RTCPeerConnectionState | 'idle'>('idle');
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [iceConfig, setIceConfig] = useState<IceConfig | null>(null);
  const [log, setLog] = useState<SignalLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logBuffer = useRef<SignalLogEntry[]>([]);

  useEffect(() => {
    const token = agentToken.get();
    if (!token) {
      setSocketState('unauthorized');
      return;
    }
    let disposed = false;
    let peer: AgentPeer | null = null;
    const socket: Socket = connectSignaling('agent', token);

    const pushLog = (entry: SignalLogEntry) => {
      logBuffer.current = [...logBuffer.current.slice(-199), entry];
    };
    const flush = setInterval(() => {
      if (!disposed) setLog(logBuffer.current);
    }, 1000);

    const finish = (state: SocketState) => {
      peer?.close();
      setSocketState(state);
      socket.io.opts.reconnection = false;
      socket.disconnect();
    };

    socket.on('connect', async () => {
      pushLog({ ts: Date.now(), direction: 'local', event: 'socket-connected', detail: socket.io.engine?.transport?.name });
      const r = await emitWithAck<{ session: SessionView; state: LiveSessionState; iceConfig: IceConfig }>(socket, SOCKET_EVENTS.agentAttach, {
        sessionId,
      });
      if (disposed) return;
      if (!r.ok || !r.data) {
        const err = r.ok ? 'no_data' : r.error;
        if (err === 'session_ended') finish('ended');
        else if (err === 'unauthorized') finish('unauthorized');
        else {
          setError(err);
          finish('error');
        }
        return;
      }
      const { session: s, state, iceConfig: ice } = r.data;
      setSession(s);
      setLive(state);
      setIceConfig(ice);
      setSocketState('online');
      if (!peer) {
        peer = new AgentPeer(socket, ice, {
          onStream: (ms) => !disposed && setStream(ms),
          onConnectionState: (st) => !disposed && setPcState(st),
          onLog: pushLog,
          onStats: (snap) => !disposed && setStats(snap),
        });
      } else {
        peer.setIceConfig(ice);
      }
      if (peer.hasLiveConnection()) peer.reportCurrentState();
      else if (state.customerOnline && state.shareActive) void peer.requestOffer(false);
    });

    socket.on(SOCKET_EVENTS.sessionState, (state: LiveSessionState) => {
      if (disposed || state.sessionId !== sessionId) return;
      setLive(state);
      if (state.status === 'share_stopped') peer?.close();
    });

    socket.on(SOCKET_EVENTS.sessionEnded, () => {
      if (disposed) return;
      setLive((l) => (l ? { ...l, status: 'ended' } : l));
      finish('ended');
    });

    socket.on(SOCKET_EVENTS.replaced, (payload: { reason?: string }) => {
      if (disposed) return;
      pushLog({ ts: Date.now(), direction: 'in', event: 'replaced', detail: payload?.reason });
      finish(payload?.reason === 'logged_out' ? 'unauthorized' : 'replaced');
    });

    socket.on('disconnect', (reason) => {
      if (disposed) return;
      pushLog({ ts: Date.now(), direction: 'local', event: 'socket-disconnected', detail: reason });
      setSocketState((s) => (s === 'online' || s === 'connecting' ? 'reconnecting' : s));
    });

    socket.on('connect_error', (err) => {
      if (disposed) return;
      pushLog({ ts: Date.now(), direction: 'local', event: 'socket-error', detail: err.message });
      if (err.message === 'unauthorized') finish('unauthorized');
      else setSocketState((s) => (s === 'online' ? 'reconnecting' : s));
    });

    return () => {
      disposed = true;
      clearInterval(flush);
      peer?.dispose();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [sessionId]);

  return { socketState, session, live, stream, pcState, stats, iceConfig, log, error, setSession };
}
