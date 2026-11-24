import type { Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type IceConfig, type RequestOfferPayload, type SignalMessage } from '../../../../shared/protocol';
import { CandidateQueue } from './candidateQueue';
import { describeSignal, emitWithAck, randomPcId, type SignalLogEntry } from './signalingClient';
import { sampleStats, type RawCounters, type StatsSnapshot } from './stats';

export interface CustomerPeerEvents {
  onConnectionState(state: RTCPeerConnectionState | 'idle'): void;
  onShareEnded(): void;
  onLog(entry: SignalLogEntry): void;
  onStats(snapshot: StatsSnapshot): void;
}

/** Constraints for readable screen content: up to 1920x1080 at up to 15 fps, no audio. */
export function displayMediaOptions(media: IceConfig['media']): DisplayMediaStreamOptions {
  return {
    video: {
      width: { ideal: media.maxWidth, max: media.maxWidth },
      height: { ideal: media.maxHeight, max: media.maxHeight },
      frameRate: { ideal: media.maxFrameRate, max: media.maxFrameRate },
      displaySurface: 'monitor',
    } as MediaTrackConstraints,
    audio: false,
    // Chromium hints; ignored by browsers that do not support them.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions;
}

/**
 * Starts the native screen picker. Must be called synchronously inside the click
 * handler, before any other await, so the browser keeps the user activation.
 */
export function captureScreen(media: IceConfig['media']): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia(displayMediaOptions(media));
}

export function isScreenShareSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';
}

/** Sender side. The customer is always the offerer and the only side that performs ICE restarts. */
export class CustomerPeer {
  private stream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private pcId: string | null = null;
  private readonly queue = new CandidateQueue<RTCIceCandidateInit>();
  private chain: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private counters: RawCounters | null = null;
  private failures = 0;
  private disposed = false;

  constructor(
    private readonly socket: Socket,
    private iceConfig: IceConfig,
    private readonly events: CustomerPeerEvents,
  ) {
    socket.on(SOCKET_EVENTS.signal, this.handleSignal);
    socket.on(SOCKET_EVENTS.requestOffer, this.handleRequestOffer);
  }

  setIceConfig(config: IceConfig): void {
    this.iceConfig = config;
  }

  get isSharing(): boolean {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  get trackSettings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  attachStream(stream: MediaStream): void {
    this.stopStream();
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no_video_track');
    // "detail" makes encoders favour sharpness (text) over motion smoothness.
    track.contentHint = 'detail';
    track.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.log('local', 'track-ended', 'screen sharing stopped in browser UI');
      this.stopSharing();
      this.events.onShareEnded();
    });
  }

  /** Starts (or restarts) negotiation with the agent. */
  negotiate(iceRestart: boolean): void {
    this.enqueue(() => this.createOffer(iceRestart));
  }

  stopSharing(): void {
    this.stopStream();
    this.closePc();
    this.events.onConnectionState('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.socket.off(SOCKET_EVENTS.signal, this.handleSignal);
    this.socket.off(SOCKET_EVENTS.requestOffer, this.handleRequestOffer);
    this.stopSharing();
  }

  // ------------------------------------------------------------------ internals

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => this.log('local', 'error', (err as Error).message));
  }

  private log(direction: SignalLogEntry['direction'], event: string, detail?: string) {
    this.events.onLog({ ts: Date.now(), direction, event, detail });
  }

  private send(msg: SignalMessage): void {
    this.log('out', msg.kind, describeSignal(msg));
    void emitWithAck(this.socket, SOCKET_EVENTS.signal, msg).then((r) => {
      if (!r.ok) this.log('local', 'signal-rejected', `${msg.kind}: ${r.error}`);
    });
  }

  private stopStream(): void {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }

  private closePc(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.restartTimer = null;
    this.statsTimer = null;
    this.counters = null;
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.pcId = null;
    this.queue.reset(null);
  }

  private async createOffer(iceRestart: boolean): Promise<void> {
    if (this.disposed || !this.stream) return;
    const existing = this.pc;
    if (iceRestart && existing && existing.connectionState !== 'closed') {
      if (existing.signalingState !== 'stable') return; // a negotiation is already in flight
      this.queue.unready();
      this.log('local', 'ice-restart');
      const offer = await existing.createOffer({ iceRestart: true });
      await existing.setLocalDescription(offer);
      this.send({ pcId: this.pcId!, kind: 'offer', sdp: existing.localDescription!.sdp });
      return;
    }

    this.closePc();
    const pcId = randomPcId();
    const pc = new RTCPeerConnection({
      iceServers: this.iceConfig.iceServers,
      iceTransportPolicy: this.iceConfig.iceTransportPolicy,
    });
    this.pc = pc;
    this.pcId = pcId;
    this.queue.reset(pcId);
    this.log('local', 'pc-created', `policy=${this.iceConfig.iceTransportPolicy} pc=${pcId.slice(0, 6)}`);

    const track = this.stream.getVideoTracks()[0]!;
    pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: this.iceConfig.media.maxBitrateKbps * 1000, maxFramerate: this.iceConfig.media.maxFrameRate }],
    });

    pc.onicecandidate = (e) => {
      if (this.pc !== pc) return;
      if (e.candidate) this.send({ pcId, kind: 'candidate', candidate: e.candidate.toJSON() as SignalMessage['candidate'] });
      else this.send({ pcId, kind: 'end-of-candidates' });
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc === pc) this.log('local', 'ice-state', pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => this.handlePcState(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ pcId, kind: 'offer', sdp: pc.localDescription!.sdp });
  }

  private handlePcState(pc: RTCPeerConnection): void {
    if (this.pc !== pc) return;
    const state = pc.connectionState;
    this.log('local', 'connection-state', state);
    this.events.onConnectionState(state);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (state === 'connected') {
      this.failures = 0;
      void this.applySenderParameters(pc);
      this.startStats(pc);
    } else if (state === 'disconnected') {
      // Often transient (Wi-Fi roaming); restart ICE only if it does not recover by itself.
      this.restartTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState === 'disconnected') this.negotiate(true);
      }, 5000);
    } else if (state === 'failed') {
      this.failures += 1;
      const delay = Math.min(1000 * 2 ** (this.failures - 1), 8000);
      this.restartTimer = setTimeout(() => {
        if (this.pc === pc) this.negotiate(this.failures <= 2);
      }, delay);
    }
  }

  private async applySenderParameters(pc: RTCPeerConnection): Promise<void> {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0]!.maxBitrate = this.iceConfig.media.maxBitrateKbps * 1000;
      params.encodings[0]!.maxFramerate = this.iceConfig.media.maxFrameRate;
      // Keep text sharp: under congestion reduce frame rate before resolution.
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch (err) {
      this.log('local', 'sender-params', (err as Error).message);
    }
  }

  private startStats(pc: RTCPeerConnection): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (this.pc !== pc) return;
      try {
        const { snapshot, counters } = await sampleStats(pc, this.counters, this.iceConfig.media.maxFrameRate);
        this.counters = counters;
        this.events.onStats(snapshot);
      } catch {
        // stats are best effort
      }
    }, 2000);
  }

  private readonly handleSignal = (msg: SignalMessage): void => {
    this.enqueue(async () => {
      const pc = this.pc;
      if (!pc || msg.pcId !== this.pcId) {
        this.log('in', 'dropped', describeSignal(msg));
        return;
      }
      this.log('in', msg.kind, describeSignal(msg));
      if (msg.kind === 'answer' && msg.sdp) {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        for (const c of this.queue.markReady(msg.pcId)) await pc.addIceCandidate(c).catch(() => undefined);
      } else if (msg.kind === 'candidate' && msg.candidate) {
        if (this.queue.offer(msg.pcId, msg.candidate) === 'apply') {
          await pc.addIceCandidate(msg.candidate).catch((err: Error) => this.log('local', 'candidate-error', err.message));
        }
      }
    });
  };

  private readonly handleRequestOffer = (payload: RequestOfferPayload): void => {
    if (!this.stream) {
      this.log('in', 'request-offer', 'ignored (not sharing)');
      return;
    }
    this.log('in', 'request-offer', payload.iceRestart ? 'ice restart' : 'new connection');
    this.negotiate(payload.iceRestart && !!this.pc);
  };
}
