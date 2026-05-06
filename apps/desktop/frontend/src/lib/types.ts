export type LLMCallRecord = {
  step: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};
