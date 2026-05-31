import { describe, it, expect } from 'vitest';
import { PUBLIC_READONLY_TOOL_ANNOTATIONS } from '../src/tool-annotations.js';

/**
 * CHATGPT-APP-DIRECTORY-SUBMIT-W1 — pins the public tool-annotation hints the
 * OpenAI Apps SDK / ChatGPT App Directory review relies on. If any of these
 * regress, the app risks being mis-classified as a write/destructive tool
 * (extra confirmation gate, or policy rejection). Keep this test in lock-step
 * with src/tool-annotations.ts.
 */
describe('PUBLIC_READONLY_TOOL_ANNOTATIONS (Apps SDK / ChatGPT App Directory hints)', () => {
  it('marks public tools read-only', () => {
    expect(PUBLIC_READONLY_TOOL_ANNOTATIONS.readOnlyHint).toBe(true);
  });

  it('marks public tools non-destructive (no irreversible side effects)', () => {
    expect(PUBLIC_READONLY_TOOL_ANNOTATIONS.destructiveHint).toBe(false);
  });

  it('keeps openWorldHint true (tools surface live external market data)', () => {
    expect(PUBLIC_READONLY_TOOL_ANNOTATIONS.openWorldHint).toBe(true);
  });

  it('carries exactly the three reviewed hints — no silent drift', () => {
    expect(Object.keys(PUBLIC_READONLY_TOOL_ANNOTATIONS).sort()).toEqual([
      'destructiveHint',
      'openWorldHint',
      'readOnlyHint',
    ]);
  });
});
