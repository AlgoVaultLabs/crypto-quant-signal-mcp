/**
 * tool-metadata-projection.ts — GROWTH-AGENT-SIGNIN-OAUTH-W4-R2 CH1.
 *
 * `tools/list` is projected per caller from the caller's platform profile (`client-registry.ts`):
 *   - `default` — the identity. The SAME description string and the SAME zod shape object come back,
 *     so every client without a declared profile is served byte-identical metadata.
 *   - `plain`   — the same constants through `plainText` (`tool-descriptions.ts`): each description
 *     and each parameter description is re-described, and `PLAIN_OMITTED_PARAMS` are dropped. The
 *     validators are untouched — zod's `.describe()` clones the schema with only the text replaced, so
 *     `.optional()`, `.default()` and every bound a parameter carries survive the projection.
 *
 * Pure: the profile is passed in (`createServer` reads it from the request), so this stays testable
 * without a request context and imports nothing that could close a cycle.
 */
import type { z } from 'zod';
import { plainText, PLAIN_OMITTED_PARAMS } from '../tool-descriptions.js';
import type { ClientProfile } from './client-registry.js';

export interface ProjectedToolMetadata {
  description: string;
  shape: z.ZodRawShape;
}

export function projectToolMetadata(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  profile: ClientProfile,
): ProjectedToolMetadata {
  if (profile.metadata === 'default') return { description, shape };
  const omitted = new Set(PLAIN_OMITTED_PARAMS[name] ?? []);
  const plainShape: z.ZodRawShape = {};
  for (const [param, schema] of Object.entries(shape)) {
    if (omitted.has(param)) continue;
    plainShape[param] = schema.description === undefined ? schema : schema.describe(plainText(schema.description));
  }
  return { description: plainText(description), shape: plainShape };
}
