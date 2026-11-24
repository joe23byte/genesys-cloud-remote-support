import type { Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type IceConfig, type MediaStatePayload, type SignalMessage } from '../../../../shared/protocol';
import { CandidateQueue } from './candidateQueue';
import { describeSignal, emitWithAck, type SignalLogEntry } from './signalingClient';
import { connectionCandidateType, sampleStats, type RawCounters, type StatsSnapshot } from './stats';

export interface AgentPeerEvents {
  onStream(stream: MediaStream | null): void;
  onConnectionState(state: RTCPeerConnectionState | 'idle'): void;
  onLog(entry: SignalLogEntry): void;
  onStats(snapshot: StatsSnapshot): void;
}

/** Receive-only side. Answers offers and asks the customer to renegotiate when the connection breaks. */
export class AgentPeer {
  private pc: RTCPeerConnection | null = null;
  private pcId: string | null = null;
  private readonly queue = new CandidateQueue<RTCIceCandidateInit>();
  private chain: Promise<void> = Promise.resolve();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private counters: RawCounters | null = null;
  private failures = 0;
  private lastCandidateType: string | undefined;
  private disposed = false;

  constructor(
    private readonly socket: Socket,
    private iceConfig: IceConfig,
    private readonly events: AgentPeerEvents,
  ) {
    socket.on(SOCKET_EVENTS.signal, this.handleSignal);
  }

  setIceConfig(config: IceConfig): void {
    this.iceConfig = config;
  }

  hasLiveConnection(): boolean {
    return !!this.pc && !['failed', 'closed'].includes(this.pc.connectionState);
  }

  get connectionState(): RTCPeerConnectionState | 'idle' {
    return this.pc?.connectionState ?? 'idle';
  }

  async requestOffer(iceRestart: boolean): Promise<void> {
    this.log('out', 'request-offer', iceRestart ? 'ice restart' : 'new connection');
    const r = await emitWithAck(this.socket, SOCKET_EVENTS.requestOffer, { iceRestart });
    if (!r.ok) this.log('local', 'request-offer-failed', r.error);
  }

  /** Re-sends the current media state, e.g. after the signaling socket reconnected. */
  reportCurrentState(): void {
    if (!this.pc) return;
    const s = this.pc.connectionState;
    if (s === 'connected') this.report({ state: 'connected', candidateType: this.lastCandidateType as MediaStatePayload['candidateType'] });
    else if (s === 'disconnected') this.report({ state: 'interrupted' });
    else if (s === 'failed') this.report({ state: 'failed' });
  }

  /** Closes the current connection (customer stopped sharing or session ended). */
  close(): void {
    this.closePc();
    this.events.onStream(null);
    this.events.onConnectionState('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.socket.off(SOCKET_EVENTS.signal, this.handleSignal);
    this.close();
  }

  // ------------------------------------------------------------------ internals

  private log(direction: SignalLogEntry['direction'], event: string, detail?: string) {
    this.events.onLog({ ts: Date.now(), direction, event, detail });
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => this.log('local', 'error', (err as Error).message));
  }

  private send(msg: SignalMessage): void {
    this.log('out', msg.kind, describeSignal(msg));
    void emitWithAck(this.socket, SOCKET_EVENTS.signal, msg).then((r) => {
      if (!r.ok) this.log('local', 'signal-rejected', `${msg.kind}: ${r.error}`);
    });
  }

  private report(payload: MediaStatePayload): void {
    void emitWithAck(this.socket, SOCKET_EVENTS.mediaState, payload);
  }

  private closePc(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.recoveryTimer = null;
    this.statsTimer = null;
    this.counters = null;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.pcId = null;
    this.queue.reset(null);
  }

  private createPc(pcId: string): RTCPeerConnection {
    this.closePc();
    const pc = new RTCPeerConnection({
      iceServers: this.iceConfig.iceServers,
      iceTransportPolicy: this.iceConfig.iceTransportPolicy,
    });
    this.pc = pc;
    this.pcId = pcId;
    this.queue.reset(pcId);
    this.log('local', 'pc-created', `policy=${this.iceConfig.iceTransportPolicy} pc=${pcId.slice(0, 6)}`);

    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.log('local', 'track', `${e.track.kind}`);
      this.events.onStream(stream);
    };
    pc.onicecandidate = (e) => {
      if (this.pc !== pc) return;
      if (e.candidate) this.send({ pcId, kind: 'candidate', candidate: e.candidate.toJSON() as SignalMessage['candidate'] });
      else this.send({ pcId, kind: 'end-of-candidates' });
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc === pc) this.log('local', 'ice-state', pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => this.handlePcState(pc);
    return pc;
  }

  private handlePcState(pc: RTCPeerConnection): void {
    if (this.pc !== pc) return;
    const state = pc.connectionState;
    this.log('local', 'connection-state', state);
    this.events.onConnectionState(state);
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (state === 'connected') {
      this.failures = 0;
      this.startStats(pc);
      void sampleStats(pc, null, this.iceConfig.media.maxFrameRate)
        .then(({ snapshot }) => {
          this.lastCandidateType = connectionCandidateType(snapshot);
          this.report({ state: 'connected', candidateType: this.lastCandidateType as MediaStatePayload['candidateType'] });
        })
        .catch(() => this.report({ state: 'connected' }));
    } else if (state === 'disconnected') {
      this.report({ state: 'interrupted' });
      this.recoveryTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState === 'disconnected') void this.requestOffer(true);
      }, 6000);
    } else if (state === 'failed') {
      this.report({ state: 'failed' });
      this.failures += 1;
      if (this.failures > 4) {
        this.log('local', 'recovery-paused', 'waiting for the customer to share again');
        return;
      }
      // The customer normally restarts ICE itself; this is the fallback if its signal got lost.
      const delay = Math.min(2000 * 2 ** (this.failures - 1), 15000);
      this.recoveryTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState === 'failed') void this.requestOffer(this.failures <= 2);
      }, delay);
    }
  }

  private startStats(pc: RTCPeerConnection): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (this.pc !== pc) return;
      try {
        const { snapshot, counters } = await sampleStats(pc, this.counters, this.iceConfig.media.maxFrameRate);
        this.counters = counters;
        const type = connectionCandidateType(snapshot);
        if (type !== this.lastCandidateType && pc.connectionState === 'connected') {
          this.lastCandidateType = type;
          this.report({ state: 'connected', candidateType: type as MediaStatePayload['candidateType'] });
        }
        this.events.onStats(snapshot);
      } catch {
        // stats are best effort
      }
    }, 1000);
  }

  private readonly handleSignal = (msg: SignalMessage): void => {
    this.enqueue(async () => {
      if (this.disposed) return;
      if (msg.kind === 'offer' && msg.sdp) {
        this.log('in', 'offer', describeSignal(msg));
        let pc = this.pc;
        if (!pc || msg.pcId !== this.pcId) pc = this.createPc(msg.pcId);
        else this.queue.unready(); // ICE restart on the existing connection
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        for (const c of this.queue.markReady(msg.pcId)) await pc.addIceCandidate(c).catch(() => undefined);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ pcId: msg.pcId, kind: 'answer', sdp: pc.localDescription!.sdp });
        return;
      }
      const pc = this.pc;
      if (!pc || msg.pcId !== this.pcId) {
        this.log('in', 'dropped', describeSignal(msg));
        return;
      }
      this.log('in', msg.kind, describeSignal(msg));
      if (msg.kind === 'candidate' && msg.candidate) {
        if (this.queue.offer(msg.pcId, msg.candidate) === 'apply') {
          await pc.addIceCandidate(msg.candidate).catch((err: Error) => this.log('local', 'candidate-error', err.message));
        }
      }
    });
  };
}
