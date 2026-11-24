export type Quality = 'good' | 'fair' | 'poor' | 'unknown';

export interface StatsSnapshot {
  timestamp: number;
  direction: 'inbound' | 'outbound';
  connectionState: string;
  iceConnectionState: string;
  iceGatheringState: string;
  signalingState: string;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  transportProtocol: string | null;
  relayProtocol: string | null;
  rttMs: number | null;
  availableBitrateKbps: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  packetsLost: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  framesDropped: number | null;
  nackCount: number | null;
  pliCount: number | null;
  qualityLimitationReason: string | null;
  codec: string | null;
  quality: Quality;
}

export interface RawCounters {
  timestamp: number;
  bytes: number;
  packets: number;
  packetsLost: number;
}

type Report = Record<string, unknown> & { type: string; id: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function rateQuality(input: { rttMs: number | null; packetLossPct: number | null; fps: number | null; targetFps: number }): Quality {
  const { rttMs, packetLossPct, fps, targetFps } = input;
  if (rttMs === null && packetLossPct === null && fps === null) return 'unknown';
  let score = 0;
  if (packetLossPct !== null) score += packetLossPct > 8 ? 2 : packetLossPct > 2 ? 1 : 0;
  if (rttMs !== null) score += rttMs > 400 ? 2 : rttMs > 200 ? 1 : 0;
  // Screen content legitimately drops to low frame rates when nothing changes, so fps alone is never "poor".
  if (fps !== null && fps < targetFps * 0.3 && fps > 0) score += 1;
  return score >= 3 ? 'poor' : score >= 1 ? 'fair' : 'good';
}

/**
 * Builds a diagnostic snapshot from RTCPeerConnection.getStats().
 * Candidate addresses are intentionally not included.
 */
export function summarizeStats(
  pc: Pick<RTCPeerConnection, 'connectionState' | 'iceConnectionState' | 'iceGatheringState' | 'signalingState'>,
  reports: Iterable<Report>,
  previous: RawCounters | null,
  targetFps: number,
): { snapshot: StatsSnapshot; counters: RawCounters | null } {
  const byId = new Map<string, Report>();
  for (const r of reports) byId.set(r.id, r);
  const all = [...byId.values()];

  const rtp =
    all.find((r) => r.type === 'inbound-rtp' && r.kind === 'video') ?? all.find((r) => r.type === 'outbound-rtp' && r.kind === 'video');
  const direction: 'inbound' | 'outbound' = rtp?.type === 'outbound-rtp' ? 'outbound' : 'inbound';

  let pair: Report | undefined;
  const transport = all.find((r) => r.type === 'transport');
  const selectedId = str(transport?.selectedCandidatePairId);
  if (selectedId) pair = byId.get(selectedId);
  if (!pair) pair = all.find((r) => r.type === 'candidate-pair' && (r.selected === true || (r.nominated === true && r.state === 'succeeded')));
  const local = pair ? byId.get(str(pair.localCandidateId) ?? '') : undefined;
  const remote = pair ? byId.get(str(pair.remoteCandidateId) ?? '') : undefined;
  const codecReport = rtp ? byId.get(str(rtp.codecId) ?? '') : undefined;

  const bytes = num(direction === 'inbound' ? rtp?.bytesReceived : rtp?.bytesSent);
  const packets = num(direction === 'inbound' ? rtp?.packetsReceived : rtp?.packetsSent);
  const lost = direction === 'inbound' ? num(rtp?.packetsLost) : null;
  const timestamp = num(rtp?.timestamp) ?? Date.now();

  let bitrateKbps: number | null = null;
  let packetLossPct: number | null = null;
  let counters: RawCounters | null = null;
  if (bytes !== null && packets !== null) {
    counters = { timestamp, bytes, packets, packetsLost: lost ?? 0 };
    if (previous && timestamp > previous.timestamp) {
      const dt = (timestamp - previous.timestamp) / 1000;
      bitrateKbps = Math.max(0, Math.round(((bytes - previous.bytes) * 8) / dt / 1000));
      if (lost !== null) {
        const dLost = Math.max(0, lost - previous.packetsLost);
        const dRecv = Math.max(0, packets - previous.packets);
        packetLossPct = dLost + dRecv > 0 ? Math.round((dLost / (dLost + dRecv)) * 1000) / 10 : 0;
      }
    }
  }

  const rtt = num(pair?.currentRoundTripTime);
  const rttMs = rtt === null ? null : Math.round(rtt * 1000);
  const fps = num(rtp?.framesPerSecond);
  const available = num(direction === 'inbound' ? pair?.availableIncomingBitrate : pair?.availableOutgoingBitrate);
  const jitter = num(rtp?.jitter);

  const snapshot: StatsSnapshot = {
    timestamp,
    direction,
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    localCandidateType: str(local?.candidateType),
    remoteCandidateType: str(remote?.candidateType),
    transportProtocol: str(local?.protocol),
    relayProtocol: str(local?.relayProtocol),
    rttMs,
    availableBitrateKbps: available === null ? null : Math.round(available / 1000),
    frameWidth: num(rtp?.frameWidth),
    frameHeight: num(rtp?.frameHeight),
    fps: fps === null ? null : Math.round(fps * 10) / 10,
    bitrateKbps,
    packetsLost: lost,
    packetLossPct,
    jitterMs: jitter === null ? null : Math.round(jitter * 1000),
    framesDropped: num(rtp?.framesDropped),
    nackCount: num(rtp?.nackCount),
    pliCount: num(rtp?.pliCount),
    qualityLimitationReason: str(rtp?.qualityLimitationReason),
    codec: str(codecReport?.mimeType),
    quality: rateQuality({ rttMs, packetLossPct, fps, targetFps }),
  };
  return { snapshot, counters };
}

export function connectionCandidateType(s: Pick<StatsSnapshot, 'localCandidateType' | 'remoteCandidateType'>): string {
  if (s.localCandidateType === 'relay' || s.remoteCandidateType === 'relay') return 'relay';
  return s.localCandidateType ?? 'unknown';
}

export async function sampleStats(pc: RTCPeerConnection, previous: RawCounters | null, targetFps: number) {
  const report = await pc.getStats();
  const reports: Report[] = [];
  report.forEach((r) => reports.push(r as Report));
  return summarizeStats(pc, reports, previous, targetFps);
}
