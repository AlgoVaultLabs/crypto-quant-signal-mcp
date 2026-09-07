// CONVERSION-SURFACES-W2 CH2 R1/R2 — the landing page's doors are tagged, and the COPY button
// actually copies.
//
// WHY CLASS TAGGING AND NOT onclick=plausible(...). Measured in the served /js/insights.js
// (6201 B, fetched 2026-09-07): the script matches /plausible-event-name(=|--)(.+)/ on the
// clicked element or up to 3 ancestors, `+` decodes to a space, and a SECOND handler fires
// tagged events on non-anchor elements — which is what lets a <button> emit at all. One class
// token therefore works identically in static HTML, the TS renderers and the JSX artboards.
//
// THE CONSEQUENCE THAT IS DELIBERATE, asserted here so nobody "fixes" it later: that script's
// first handler is `if (!E(n,0)) { ... return Outbound Link: Click }`, so a TAGGED anchor
// early-returns past the outbound branch. The hero Telegram CTA now emits `CTA Click` INSTEAD
// OF `Outbound Link: Click`. The 2026-09-21 readout unions the two across the cutover.
//
// The 40 incumbent onclick=plausible('CTA Click', {source, medium, campaign}) sites are NOT
// touched this wave — a WIS bullet names the unification. This test asserts only that the NEW
// emitters exist and are well-formed, never that the old ones are gone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  COPY_BUTTON_IDLE_LABEL,
  COPY_BUTTON_COPIED_LABEL,
  COPY_BUTTON_COPIED_MS,
} from '../../src/lib/conversion-copy.js';

const INDEX = readFileSync(join(process.cwd(), 'landing', 'index.html'), 'utf8');
const count = (needle: string): number => (INDEX.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;

/** The exact predicate the SERVED plausible script uses to decide an element is tagged. */
const SERVED_TAGGED_RE = /plausible-event-name(=|--)(.+)/;

describe('landing CTA events — coverage', () => {
  it('tags exactly the four doors, twice each (dual render)', () => {
    expect(count('plausible-event-location=hero')).toBe(4); // telegram + track-record, x2 artboards
    expect(count('plausible-event-location=trust')).toBe(2); // trust-band start-free
    expect(count('plausible-event-location=quickstart')).toBe(2); // the COPY button
    // The gate hard-codes this same total; a new door must move both together.
    expect(count('plausible-event-location=')).toBe(8);
  });

  it('names every emitter CTA Click and gives each a cta value', () => {
    expect(count('plausible-event-name=CTA+Click')).toBe(8);
    for (const [cta, n] of [['telegram', 2], ['track-record', 2], ['start-free', 2], ['copy-mcp-url', 2]] as const) {
      expect(count(`plausible-event-cta=${cta}`)).toBe(n);
    }
  });

  it('every tag class is one the SERVED script would actually match', () => {
    const classes = INDEX.match(/class="[^"]*plausible-event-[^"]*"/g) ?? [];
    expect(classes.length).toBe(8);
    for (const c of classes) {
      const tokens = c.slice(7, -1).split(/\s+/);
      expect(tokens.some((t) => SERVED_TAGGED_RE.test(t))).toBe(true);
      // `+` is the script's space encoding; a literal space would split the event name in two.
      expect(tokens).toContain('plausible-event-name=CTA+Click');
    }
  });

  it('leaves the pricing buttons and the 40 incumbent emitters alone', () => {
    expect(count("plausible('Plan Selection'")).toBe(8);
    expect(count("plausible('Signup Click'")).toBe(8);
    expect(count("plausible('CTA Click'")).toBe(4); // the two pre-existing track-record links, x2
  });
});

/** Extract the shipped clipboard controller from the committed page. */
function copyControllerSource(): string {
  const hit = (INDEX.match(/<script>([\s\S]*?)<\/script>/g) ?? []).find((b) => b.includes('__avCopyUrlInit'));
  expect(hit, 'the clipboard controller must be present in landing/index.html').toBeTruthy();
  return (hit as string).replace(/^<script>/, '').replace(/<\/script>$/, '');
}

describe('quickstart COPY button — wired, and copies what it shows', () => {
  it('carries the hook and the displayed-URL marker, once per artboard', () => {
    expect(count('data-av-copy-url="true"')).toBe(2);
    expect(count('data-av-copy-src=""')).toBe(2);
  });

  it('never ships the transient label in static HTML (the rendered-text gate depends on it)', () => {
    // It appears ONLY as a JS string literal inside the controller, never as markup text.
    expect(INDEX.includes(`>${COPY_BUTTON_COPIED_LABEL}<`)).toBe(false);
    expect(count(`>${COPY_BUTTON_IDLE_LABEL}</button>`)).toBe(2);
  });

  it('copies the DISPLAYED text node and flashes the transient label', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><article>
         <button data-av-copy-url="true">${COPY_BUTTON_IDLE_LABEL}</button>
         <div data-av-copy-src="">  https://api.algovault.com/mcp  </div>
       </article></body></html>`,
      { url: 'https://algovault.com/', runScripts: 'outside-only' },
    );
    const w = dom.window as unknown as Record<string, any>;
    const wrote: string[] = [];
    w.navigator.clipboard = { writeText: (t: string) => { wrote.push(t); return Promise.resolve(); } };
    w.eval(copyControllerSource());

    const btn = dom.window.document.querySelector('[data-av-copy-url]') as HTMLElement;
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    expect(wrote).toEqual(['https://api.algovault.com/mcp']); // trimmed, exactly as displayed
    expect(btn.textContent).toBe(COPY_BUTTON_COPIED_LABEL);
    await new Promise((r) => setTimeout(r, COPY_BUTTON_COPIED_MS + 120));
    expect(btn.textContent).toBe(COPY_BUTTON_IDLE_LABEL);
  });

  it('falls back to execCommand when the async clipboard API is absent', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><article>
         <button data-av-copy-url="true">${COPY_BUTTON_IDLE_LABEL}</button>
         <div data-av-copy-src="">https://api.algovault.com/mcp</div>
       </article></body></html>`,
      { url: 'https://algovault.com/', runScripts: 'outside-only' },
    );
    const w = dom.window as unknown as Record<string, any>;
    delete w.navigator.clipboard;
    let legacy: string | null = null;
    w.document.execCommand = (cmd: string) => {
      if (cmd === 'copy') legacy = (w.document.querySelector('textarea') as HTMLTextAreaElement).value;
      return true;
    };
    w.eval(copyControllerSource());
    const btn = dom.window.document.querySelector('[data-av-copy-url]') as HTMLElement;
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(legacy).toBe('https://api.algovault.com/mcp');
    expect(btn.textContent).toBe(COPY_BUTTON_COPIED_LABEL);
  });

  it('does nothing when there is no displayed URL to copy (never invents a string)', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><article><button data-av-copy-url="true">${COPY_BUTTON_IDLE_LABEL}</button></article></body></html>`,
      { url: 'https://algovault.com/', runScripts: 'outside-only' },
    );
    const w = dom.window as unknown as Record<string, any>;
    const wrote: string[] = [];
    w.navigator.clipboard = { writeText: (t: string) => { wrote.push(t); return Promise.resolve(); } };
    w.eval(copyControllerSource());
    const btn = dom.window.document.querySelector('[data-av-copy-url]') as HTMLElement;
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(wrote).toEqual([]);
    expect(btn.textContent).toBe(COPY_BUTTON_IDLE_LABEL);
  });
});
