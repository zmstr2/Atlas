// Per-call serializing chain: utterances arriving while one pipeline is in flight
// queue onto the chain so none are silently dropped.
const pipelineChains = new Map<string, Promise<unknown>>();

export function enqueuePipeline(callId: string, fn: () => Promise<void>): Promise<void> {
  const prev = pipelineChains.get(callId) ?? Promise.resolve();
  const next = prev.then(fn).catch(err => console.error('[coach pipeline]', callId, err));
  pipelineChains.set(callId, next);
  return next;
}

export function clearPipelineChain(callId: string): void {
  pipelineChains.delete(callId);
}
