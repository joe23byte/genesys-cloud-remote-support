import { z } from 'zod';
import { LIMITS } from '../../../shared/protocol.js';

const pcId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const signalSchema = z.discriminatedUnion('kind', [
  z.object({ pcId, kind: z.literal('offer'), sdp: z.string().min(10).max(LIMITS.maxSdpLength) }),
  z.object({ pcId, kind: z.literal('answer'), sdp: z.string().min(10).max(LIMITS.maxSdpLength) }),
  z.object({
    pcId,
    kind: z.literal('candidate'),
    candidate: z.object({
      candidate: z.string().max(LIMITS.maxCandidateLength),
      sdpMid: z.string().max(32).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
  z.object({ pcId, kind: z.literal('end-of-candidates') }),
]);

export const attachSchema = z.object({ sessionId: z.string().uuid() });

export const shareStateSchema = z.object({
  state: z.enum(['started', 'stopped']),
  displaySurface: z.enum(['monitor', 'window', 'browser', 'application', 'unknown']).optional(),
  width: z.number().int().min(0).max(16384).optional(),
  height: z.number().int().min(0).max(16384).optional(),
});

export const mediaStateSchema = z.object({
  state: z.enum(['connected', 'interrupted', 'failed']),
  candidateType: z.enum(['host', 'srflx', 'prflx', 'relay', 'unknown']).optional(),
});

export const requestOfferSchema = z.object({ iceRestart: z.boolean() });
