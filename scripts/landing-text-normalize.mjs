#!/usr/bin/env node
/**
 * CONVERSION-SURFACES-W2 CH2 — the ONE derivation of "the rendered COPY of a landing page".
 *
 * WHY THIS EXISTS. CH2's gate asserts that the chapter changed no copy on `/`: it diffs the
 * page's text before and after. A raw `sed 's/<[^>]*>//g'` diff CANNOT express that assertion,
 * because the served page embeds a live-data SNAPSHOT that moves on its own:
 *
 *   - `.github/workflows/deploy.yml` runs `scripts/snapshot-landing-data.mjs` and only THEN
 *     `cp landing/*.html /var/www/algovault/`, so every deploy re-bakes the numbers.
 *   - Measured on two live captures ~40 minutes apart with NO deploy between them, the only
 *     text that moved was exactly this class: call_count 612,422 -> 615,255,
 *     total_calls_executed 67,317,144 -> 67,446,142, and the JSON-LD PropertyValue mirrors
 *     ("612422" -> "615255", asset count "2000" -> "2007").
 *
 * So a raw diff measures the SNAPSHOT CADENCE, not the wave — the same defect class as
 * "freshness alarms measure PRODUCERS, never rendered artifacts". Left raw, CH2's gate would
 * report RED for a page nobody edited. Normalising is not a relaxation: `data-tr-field` values
 * are live data BY DESIGN (Data Integrity LAW, "live data over baked-in numbers") and are
 * explicitly not copy, so removing them is what makes the gate measure the thing it names.
 *
 * Both sides of the comparison go through THIS file — the committed snapshot
 * (audits/landing-text-before.txt) and the gate's live fetch. One derivation, so the two sides
 * cannot drift apart; two `sed` pipelines maintained separately would.
 *
 *   curl -s https://algovault.com/ | node scripts/landing-text-normalize.mjs
 *
 * Normalisation, in order:
 *   1. drop <script> and <style> bodies  — never rendered text, and where the JSON-LD number
 *      mirrors live (a tag-strip keeps script CONTENT, which is why this step is required)
 *   2. replace the inner content of every [data-tr-field] element with a stable placeholder
 *   3. strip remaining tags, decode nothing, collapse whitespace runs to one space
 */
import { readFileSync } from 'node:fs';

/** Replace the CONTENT of each element carrying data-tr-field with a stable token. */
export function normalizeLandingText(html) {
  let s = String(html);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  // Non-greedy to the element's own closing tag. data-tr-field spans never nest (the
  // live-bind discipline forbids it), so a non-greedy match is exact here.
  s = s.replace(
    /<([a-zA-Z][\w-]*)\b([^>]*\sdata-tr-field="([a-z_]+)"[^>]*)>[\s\S]*?<\/\1\s*>/g,
    (_m, _tag, _attrs, field) => ` {{tr:${field}}} `,
  );
  s = s.replace(/<[^>]*>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = readFileSync(process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : 0, 'utf8');
  process.stdout.write(normalizeLandingText(html) + '\n');
}
