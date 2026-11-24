import type { IceConfig, LiveSessionState } from '../../../shared/protocol';
import type { SignalLogEntry } from '../lib/webrtc/signalingClient';
import type { StatsSnapshot } from '../lib/webrtc/stats';

const fmt = (v: number | string | null | undefined, unit = '') => (v === null || v === undefined || v === '' ? '–' : `${v}${unit}`);

export function DebugPanel({
  stats,
  pcState,
  socketState,
  iceConfig,
  live,
  log,
}: {
  stats: StatsSnapshot | null;
  pcState: string;
  socketState: string;
  iceConfig: IceConfig | null;
  live: LiveSessionState | null;
  log: SignalLogEntry[];
}) {
  const servers = iceConfig?.iceServers.flatMap((s) => s.urls.map((u) => u.replace(/\?.*$/, ''))) ?? [];
  const rows: Array<[string, string]> = [
    ['Signaling (Socket.IO)', socketState],
    ['Peer connection', pcState],
    ['ICE connection', fmt(stats?.iceConnectionState)],
    ['ICE gathering', fmt(stats?.iceGatheringState)],
    ['Signaling state', fmt(stats?.signalingState)],
    ['ICE transport policy', fmt(iceConfig?.iceTransportPolicy)],
    ['ICE servers', servers.length ? servers.join(', ') : 'none (host candidates only)'],
    ['Route (local / remote)', `${fmt(stats?.localCandidateType)} / ${fmt(stats?.remoteCandidateType)}`],
    ['Transport', `${fmt(stats?.transportProtocol)}${stats?.relayProtocol ? ` (TURN over ${stats.relayProtocol})` : ''}`],
    ['Resolution', stats?.frameWidth ? `${stats.frameWidth}×${stats.frameHeight}` : '–'],
    ['Frame rate', fmt(stats?.fps, ' fps')],
    ['Bitrate', fmt(stats?.bitrateKbps, ' kbit/s')],
    ['Available bandwidth', fmt(stats?.availableBitrateKbps, ' kbit/s')],
    ['Round-trip time', fmt(stats?.rttMs, ' ms')],
    ['Packet loss', stats?.packetLossPct !== null && stats?.packetLossPct !== undefined ? `${stats.packetLossPct}% (total ${stats.packetsLost ?? 0})` : '–'],
    ['Jitter', fmt(stats?.jitterMs, ' ms')],
    ['Frames dropped', fmt(stats?.framesDropped)],
    ['NACK / PLI', `${fmt(stats?.nackCount)} / ${fmt(stats?.pliCount)}`],
    ['Codec', fmt(stats?.codec)],
    ['Quality limitation', fmt(stats?.qualityLimitationReason)],
    ['Quality', fmt(stats?.quality)],
    ['Agent / customer online', live ? `${live.agentOnline ? 'yes' : 'no'} / ${live.customerOnline ? 'yes' : 'no'}` : '–'],
    ['Consent / share active', live ? `${live.consentGiven ? 'yes' : 'no'} / ${live.shareActive ? 'yes' : 'no'}` : '–'],
  ];
  return (
    <div className="debug" data-testid="debug-panel">
      <table className="debug__table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td data-testid={`debug-${k.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="debug__log" aria-label="Signaling log">
        {log
          .slice(-80)
          .reverse()
          .map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`debug__log-line debug__log-line--${e.direction}`}>
              <span className="debug__ts">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="debug__dir">{e.direction === 'in' ? '←' : e.direction === 'out' ? '→' : '•'}</span>
              <span>{e.event}</span>
              {e.detail && <span className="debug__detail">{e.detail}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}
