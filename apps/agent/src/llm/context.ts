import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-call cost-tracking context. Set at the top of `processUtterance` (and
 * the post-call chain) so the LLM wrapper can attribute every call to a
 * userId + callId without threading those through every agent signature.
 *
 * When unset (e.g. the wrapper is invoked from a script or test), reads
 * return undefined and the wrapper skips the spend increment silently.
 */
export type CostContext = {
  userId: string;
  callId: string;
};

export const costContext = new AsyncLocalStorage<CostContext>();

export function getCostContext(): CostContext | undefined {
  return costContext.getStore();
}
