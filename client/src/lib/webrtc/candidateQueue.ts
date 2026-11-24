/**
 * Buffers remote ICE candidates until the remote description of the matching
 * peer connection generation (pcId) is applied. Candidates of other generations are dropped.
 */
export class CandidateQueue<C> {
  private pcId: string | null = null;
  private ready = false;
  private pending: C[] = [];

  constructor(private readonly maxPending = 200) {}

  /** Starts a new peer connection generation; anything queued for the previous one is discarded. */
  reset(pcId: string | null): void {
    this.pcId = pcId;
    this.ready = false;
    this.pending = [];
  }

  get currentPcId(): string | null {
    return this.pcId;
  }

  /** Returns "apply" when the candidate can be added right away, "queued" or "dropped" otherwise. */
  offer(pcId: string, candidate: C): 'apply' | 'queued' | 'dropped' {
    if (pcId !== this.pcId) return 'dropped';
    if (this.ready) return 'apply';
    if (this.pending.length >= this.maxPending) return 'dropped';
    this.pending.push(candidate);
    return 'queued';
  }

  /** Marks the remote description as applied and returns the queued candidates in arrival order. */
  markReady(pcId: string): C[] {
    if (pcId !== this.pcId) return [];
    this.ready = true;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** An ICE restart re-applies a remote description; new candidates must wait for it again. */
  unready(): void {
    this.ready = false;
  }

  get size(): number {
    return this.pending.length;
  }
}
