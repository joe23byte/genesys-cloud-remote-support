import { describe, expect, it } from 'vitest';
import { dictionaries, resolveLang, translate } from '../../client/src/i18n';
import { CandidateQueue } from '../../client/src/lib/webrtc/candidateQueue';
import { connectionCandidateType, rateQuality, summarizeStats } from '../../client/src/lib/webrtc/stats';
import { describeSignal } from '../../client/src/lib/webrtc/signalingClient';
import { formatDuration, invalidParams, readGenesysContext } from '../../client/src/lib/params';
import { displayMediaOptions } from '../../client/src/lib/webrtc/customerPeer';

describe('ICE candidate queue', () => {
  it('queues until the remote description is applied, then flushes in order', () => {
    const q = new CandidateQueue<string>();
    q.reset('pc1');
    expect(q.offer('pc1', 'a')).toBe('queued');
    expect(q.offer('pc1', 'b')).toBe('queued');
    expect(q.markReady('pc1')).toEqual(['a', 'b']);
    expect(q.offer('pc1', 'c')).toBe('apply');
  });

  it('drops candidates of other peer connection generations', () => {
    const q = new CandidateQueue<string>();
    q.reset('pc2');
    expect(q.offer('pc1', 'old')).toBe('dropped');
    expect(q.markReady('pc1')).toEqual([]);
  });

  it('waits again after an ICE restart and bounds the queue', () => {
    const q = new CandidateQueue<number>(2);
    q.reset('p');
    q.markReady('p');
    q.unready();
    expect(q.offer('p', 1)).toBe('queued');
    expect(q.offer('p', 2)).toBe('queued');
    expect(q.offer('p', 3)).toBe('dropped');
  });
});

describe('WebRTC stats summary', () => {
  const pc = { connectionState: 'connected', iceConnectionState: 'connected', iceGatheringState: 'complete', signalingState: 'stable' } as const;
  const reports = (bytes: number, packets: number, lost: number, ts: number) => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042, availableIncomingBitrate: 3_000_000 },
    { id: 'L', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: '203.0.113.5' },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.7' },
    {
      id: 'V',
      type: 'inbound-rtp',
      kind: 'video',
      bytesReceived: bytes,
      packetsReceived: packets,
      packetsLost: lost,
      timestamp: ts,
      framesPerSecond: 14.6,
      frameWidth: 1920,
      frameHeight: 1080,
      jitter: 0.004,
      codecId: 'C',
    },
    { id: 'C', type: 'codec', mimeType: 'video/VP8' },
  ];

  it('derives bitrate, loss, route and quality without leaking addresses', () => {
    const first = summarizeStats(pc, reports(0, 0, 0, 1000), null, 15);
    const second = summarizeStats(pc, reports(250_000, 1000, 10, 2000), first.counters, 15);
    const s = second.snapshot;
    expect(s.bitrateKbps).toBe(2000);
    expect(s.packetLossPct).toBe(1);
    expect(s.rttMs).toBe(42);
    expect(s.frameWidth).toBe(1920);
    expect(s.fps).toBe(14.6);
    expect(s.localCandidateType).toBe('relay');
    expect(s.relayProtocol).toBe('tls');
    expect(s.codec).toBe('video/VP8');
    expect(s.quality).toBe('good');
    expect(connectionCandidateType(s)).toBe('relay');
    expect(JSON.stringify(s)).not.toContain('203.0.113.5');
  });

  it('rates quality', () => {
    expect(rateQuality({ rttMs: null, packetLossPct: null, fps: null, targetFps: 15 })).toBe('unknown');
    expect(rateQuality({ rttMs: 50, packetLossPct: 0, fps: 15, targetFps: 15 })).toBe('good');
    expect(rateQuality({ rttMs: 250, packetLossPct: 3, fps: 15, targetFps: 15 })).toBe('fair');
    expect(rateQuality({ rttMs: 500, packetLossPct: 10, fps: 2, targetFps: 15 })).toBe('poor');
  });
});

describe('signal descriptions for the debug log', () => {
  it('never contains SDP or IP addresses', () => {
    const d = describeSignal({ kind: 'candidate', pcId: 'abcdef123456', candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host' } });
    expect(d).toBe('candidate host/udp pc=abcdef');
    expect(describeSignal({ kind: 'offer', pcId: 'abcdef123456' })).toBe('offer pc=abcdef');
  });
});

describe('Genesys URL parameters', () => {
  it('reads interpolated values', () => {
    const ctx = readGenesysContext(
      '?conversationId=85FF71C0-F96D-45F6-9D98-FA5E01B22AF8&gcHostOrigin=https%3A%2F%2Fapps.mypurecloud.de&gcTargetEnv=prod-euc1&language=de-de',
    );
    expect(ctx).toEqual({
      conversationId: '85ff71c0-f96d-45f6-9d98-fa5e01b22af8',
      gcHostOrigin: 'https://apps.mypurecloud.de',
      gcTargetEnv: 'prod-euc1',
      language: 'de-de',
      demoMode: false,
    });
  });

  it('detects tokens that Genesys did not interpolate', () => {
    const search = '?conversationId={{gcConversationId}}&gcHostOrigin={{gcHostOrigin}}';
    expect(invalidParams(search, readGenesysContext(search))).toEqual(
      expect.arrayContaining(['conversationId', 'gcHostOrigin', 'conversationId (not interpolated)']),
    );
  });
});

describe('screen capture constraints', () => {
  it('requests video only, up to 1080p at 15 fps', () => {
    const o = displayMediaOptions({ maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15, maxBitrateKbps: 2500 }) as any;
    expect(o.audio).toBe(false);
    expect(o.systemAudio).toBe('exclude');
    expect(o.video.width.max).toBe(1920);
    expect(o.video.height.max).toBe(1080);
    expect(o.video.frameRate.max).toBe(15);
  });
});

describe('i18n', () => {
  it('has a German translation for every English key', () => {
    const en = Object.keys(dictionaries.en).sort();
    const de = Object.keys(dictionaries.de).sort();
    expect(de).toEqual(en);
    for (const k of en) expect(dictionaries.de[k as keyof typeof dictionaries.de].length).toBeGreaterThan(0);
  });

  it('resolves languages and interpolates variables', () => {
    expect(resolveLang('de-at')).toBe('de');
    expect(resolveLang(null, 'fr', 'en-US')).toBe('en');
    expect(resolveLang('fr')).toBe('en');
    expect(translate('de', 'join.sharingBanner', { agent: 'Alice' })).toBe('Ihr Bildschirm wird mit Alice geteilt');
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('00:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
