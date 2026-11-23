import { describe, expect, test } from 'bun:test';
import { zodSchema } from 'ai';
import { PanelPatchSchema, SuggestionOutputSchema } from '@atlas/types';
import { ExtractorOutputSchema } from '../agents/memoryAgent';

/**
 * Every schema we send to an LLM goes out as OpenAI strict structured output,
 * which rejects the whole request unless every property is listed in `required`
 * and objects are closed. A `.default()` or `.optional()` anywhere breaks it
 * ("Missing 'priority'"), and only for some providers, so it slips past manual
 * testing. This catches it at test time.
 */
function strictProblems(schema: Parameters<typeof zodSchema>[0]): string[] {
  const problems: string[] = [];
  const walk = (n: unknown, path: string) => {
    if (!n || typeof n !== 'object') return;
    const node = n as Record<string, unknown>;
    if (node.type === 'object' && node.properties) {
      const keys = Object.keys(node.properties as object);
      const required = new Set((node.required as string[] | undefined) ?? []);
      for (const k of keys) if (!required.has(k)) problems.push(`${path || '(root)'}: "${k}" is not required`);
      if (node.additionalProperties !== false) problems.push(`${path || '(root)'}: additionalProperties must be false`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
  };
  walk(zodSchema(schema).jsonSchema, '');
  return problems;
}

describe('LLM output schemas are OpenAI-strict safe', () => {
  test('suggester / rep-watcher output', () => {
    expect(strictProblems(SuggestionOutputSchema)).toEqual([]);
  });
  test('memory extractor output', () => {
    expect(strictProblems(ExtractorOutputSchema)).toEqual([]);
  });
  test('panel agent output', () => {
    expect(strictProblems(PanelPatchSchema)).toEqual([]);
  });
});
