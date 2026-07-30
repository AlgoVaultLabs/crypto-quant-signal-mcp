#!/usr/bin/env node
// scripts/refresh-knowledge-pages.mjs
// BUNDLE-EXPAND-BLOG-W1 (C3, 2026-05-19) — weekly refresh cron entry point.
//
// Fires Sun 06:00 UTC on Hetzner (2h before GEO-MEASUREMENT-W1 Mon 08:00 UTC
// probe so fresh content is indexed before the next measurement).
//
// Calls all 4 fetchers in Promise.allSettled() → merges + dedups by source_url
// → atomically rewrites the canonical bundle file → file-watcher
// (`KnowledgeIndex`) picks up the change on next 30s poll → BM25 index
// rebuilds transparently.
//
// `--dry-run` flag builds the digest body from current state without touching
// the bundle file or invoking Telegram. Used by C3's verification gate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import devto from './fetchers/devto.mjs';
import medium from './fetchers/medium.mjs';
import youtube from './fetchers/youtube.mjs';
import githubDiscussions from './fetchers/github-discussions.mjs';

// `dist/lib/telegram.js` is compiled CJS; ESM consumers use createRequire to
// pull the named exports (sendAlert + sendDigest). Per CLAUDE.md GEO-W1 §H:
// `sendTelegramMessage` is FICTIONAL — actual exports are `sendAlert(msg, lvl)`
// (severity 'critical'|'warning'|'info') and `sendDigest(sections: string[])`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadTelegram() {
  // dist/lib/telegram.js relative to this file:
  // /app/scripts/refresh-knowledge-pages.mjs → /app/dist/lib/telegram.js
  // (Stage 2 ships both via the Dockerfile COPYs documented in BUNDLE-EXPAND-BLOG-W1.)
  const distPath = path.resolve(__dirname, '..', 'dist', 'lib', 'telegram.js');
  try {
    const mod = require(distPath);
    return {
      sendAlert: typeof mod.sendAlert === 'function' ? mod.sendAlert : null,
      sendDigest: typeof mod.sendDigest === 'function' ? mod.sendDigest : null,
      // SEC-17: renders an interpolated value as a Markdown code span so a `_` in a
      // source name (e.g. `github_discussion`) cannot open an unterminated entity.
      mdValue: typeof mod.mdValue === 'function' ? mod.mdValue : (v) => String(v),
    };
  } catch (err) {
    console.warn(`[refresh-pages] telegram load failed (continuing): ${err.message}`);
    return { sendAlert: null, sendDigest: null, mdValue: (v) => String(v) };
  }
}

const FETCHERS = [devto, medium, youtube, githubDiscussions];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  // Container path: /app/dist/knowledge/latest.json (canonical bundle file).
  // Local dev: resolve relative to repo root.
  const defaultBundlePath = path.resolve(__dirname, '..', 'dist', 'knowledge', 'latest.json');
  const bundlePath = process.env.BUNDLE_PATH || defaultBundlePath;

  console.log(`[refresh-pages] starting · dry-run=${dryRun} · bundle=${bundlePath}`);

  const start = Date.now();
  const results = await Promise.allSettled(
    FETCHERS.map((f) => f.fetchAll().then((pages) => ({ source: f.sourceType, pages }))),
  );

  const allPages = [];
  const errors = [];
  const perSource = [];
  for (let i = 0; i < FETCHERS.length; i++) {
    const r = results[i];
    const sourceName = FETCHERS[i].sourceType;
    if (r.status === 'fulfilled') {
      const count = r.value.pages.length;
      perSource.push({ source: sourceName, status: 'ok', count });
      console.log(`[refresh-pages] ${sourceName}: ${count} pages`);
      allPages.push(...r.value.pages);
    } else {
      const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      perSource.push({ source: sourceName, status: 'failed', error: errMsg });
      errors.push({ source: sourceName, error: errMsg });
      console.error(`[refresh-pages] ${sourceName} FAILED: ${errMsg}`);
    }
  }

  // Dedup by source_url (last-write wins for same URL across sources, but
  // cross-source URL collisions are essentially impossible).
  const dedup = Array.from(new Map(allPages.map((p) => [p.source_url, p])).values());
  // Sort by published_at DESC for stable file output (avoids spurious diffs).
  dedup.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));

  const elapsedMs = Date.now() - start;
  console.log(
    `[refresh-pages] total ${dedup.length} pages deduped from ${allPages.length} raw · errors=${errors.length} · ${elapsedMs}ms`,
  );

  if (dryRun) {
    console.log('---DIGEST BODY (dry-run preview)---');
    const lines = buildDigestLines(dedup.length, allPages.length, perSource, errors);
    console.log(lines.join('\n'));
    console.log('---END---');
    console.log(`[refresh-pages] DRY RUN complete · ${dedup.length} pages would be written`);
    return;
  }

  // Atomic write: temp file → rename. fs.writeFile + fs.rename is atomic on
  // POSIX (Linux container); the file-watcher's 30s poll sees either old or
  // new bundle, never a partial state.
  let bundle;
  try {
    bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
  } catch (err) {
    console.error(`[refresh-pages] failed to read bundle at ${bundlePath}: ${err.message}`);
    throw err;
  }
  if (bundle?._algovault?.bundle_version !== 2) {
    console.warn(
      `[refresh-pages] bundle._algovault.bundle_version=${bundle?._algovault?.bundle_version} (expected 2) — proceeding but flagging`,
    );
  }
  bundle.pages = dedup;
  bundle.pages_refreshed_at = new Date().toISOString();

  const tmpPath = `${bundlePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(bundle, null, 2) + '\n');
  await fs.rename(tmpPath, bundlePath);
  console.log(`[refresh-pages] wrote ${dedup.length} pages atomically · pages_refreshed_at=${bundle.pages_refreshed_at}`);

  // Telegram digest — non-fatal if telegram module unavailable or chat unreachable.
  const { sendAlert, sendDigest, mdValue } = loadTelegram();
  const sections = buildDigestLines(dedup.length, allPages.length, perSource, errors, mdValue);
  if (typeof sendDigest === 'function') {
    try {
      // SEC-17: sendDigest returns a BOOLEAN and NEVER THROWS. This used to `await` it,
      // discard the result and log "digest sent" unconditionally — so the catch below was
      // unreachable and three consecutive weeks of HTTP 400 rendered as success. Assert
      // DELIVERY, not attempt.
      const delivered = await sendDigest(sections);
      if (delivered) {
        console.log(`[refresh-pages] digest sent · sections=${sections.length}`);
      } else {
        console.error(`[refresh-pages] DIGEST SEND FAILED · sections=${sections.length} — see the [telegram] HTTP line above`);
        process.exitCode = 1; // a load-bearing side-effect that did not happen must be visible to cron
        if (typeof sendAlert === 'function') {
          // Escalate through the plain-text-capable alert path; if THAT also fails there
          // is nothing further we can do from in-container, and the non-zero exit stands.
          await sendAlert('Knowledge-bundle weekly digest FAILED to deliver (Telegram rejected the message).', 'warning');
        }
      }
    } catch (err) {
      console.error(`[refresh-pages] DIGEST SEND THREW: ${err.message}`);
      process.exitCode = 1;
    }
  } else {
    console.warn('[refresh-pages] sendDigest unavailable — digest skipped');
  }
  if (errors.length > 0 && typeof sendAlert === 'function') {
    try {
      const summary = errors.map((e) => `${e.source}: ${e.error}`).join('; ').slice(0, 300);
      // SEC-17: same class as the digest above — assert delivery, don't assume it.
      if (await sendAlert(`Knowledge-bundle refresh: ${errors.length} fetcher(s) failed — ${summary}`, 'warning')) {
        console.log(`[refresh-pages] WARNING alert sent · failed=${errors.length}`);
      } else {
        console.error(`[refresh-pages] WARNING ALERT SEND FAILED · failed=${errors.length} — the operator was NOT notified`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.warn(`[refresh-pages] sendAlert failed (continuing): ${err.message}`);
    }
  }
}

function buildDigestLines(dedupCount, rawCount, perSource, errors, mdValue = (v) => String(v)) {
  const lines = [];
  lines.push(`📚 *Knowledge bundle pages refreshed*`);
  lines.push(`Total pages: ${dedupCount} (deduped from ${rawCount})`);
  lines.push('');
  lines.push(`*Per-source counts:*`);
  for (const s of perSource) {
    if (s.status === 'ok') {
      lines.push(`· ✅ ${mdValue(s.source)}: ${s.count}`);
    } else {
      lines.push(`· 🛑 ${mdValue(s.source)}: FAILED (${mdValue((s.error || '').slice(0, 100))})`);
    }
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${errors.length} fetcher(s) failed — check /var/log/refresh-knowledge-pages.log`);
  }
  lines.push('');
  lines.push(`Next fire: Sun 06:00 UTC weekly · feeds GEO-MEASUREMENT-W1 Mon 08:00 UTC probe`);
  return lines;
}

// Test seam (CLAUDE.md "make entrypoints test-importable"): run main() ONLY when this
// file is the process entrypoint. Importing it previously executed the whole refresh —
// network fetches included — which is why the digest body had no test and the byte-168
// Markdown defect survived three weeks of green builds (SEC-17).
export { buildDigestLines };

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[refresh-pages] FATAL:', msg);
    const { sendAlert } = loadTelegram();
    if (typeof sendAlert === 'function') {
      sendAlert(`refresh-knowledge-pages FATAL: ${msg}`, 'critical').catch(() => {});
    }
    process.exit(1);
  });
}
