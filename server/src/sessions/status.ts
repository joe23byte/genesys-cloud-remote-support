import type { SessionStatus } from '../../../shared/protocol.js';

export interface StatusInputs {
  ended: boolean;
  customerJoined: boolean;
  customerOnline: boolean;
  consentGiven: boolean;
  shareActive: boolean;
  shareStopped: boolean;
  mediaConnected: boolean;
  mediaInterrupted: boolean;
}

export function deriveStatus(i: StatusInputs): SessionStatus {
  if (i.ended) return 'ended';
  if (!i.customerJoined) return 'waiting_customer';
  if (i.shareActive) {
    if (!i.customerOnline || i.mediaInterrupted) return 'interrupted';
    return i.mediaConnected ? 'sharing' : 'waiting_share';
  }
  if (!i.customerOnline) return 'interrupted';
  if (i.shareStopped) return 'share_stopped';
  if (i.consentGiven) return 'waiting_share';
  return 'customer_connected';
}
