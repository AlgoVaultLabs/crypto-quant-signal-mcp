/**
 * stripe-rak-smoke.ts — the live check of the server's restricted Stripe key, run before a key is
 * put into service and kept for every later rotation.
 *
 * OPS-NODE-SECURITY-FLOOR-W1 / CH3 R4.
 *
 * WHY. scripts/check-stripe-rak-permissions.mjs proves offline that every request the code makes is
 * covered by `key.granted` in ops/stripe-rak-permissions.json. Only Stripe can say whether the key
 * itself holds those grants, so this asks it: from the host the key's access policy allows, through
 * the server's own request builders (src/lib/stripe.ts) where they can run harmlessly, and through
 * exact mirrors of the server's calls where they cannot.
 *
 * NOTHING IN THE LIVE ACCOUNT CHANGES. Stripe answers 403 when "the API key doesn't have
 * permissions to perform the request" (docs.stripe.com/api/errors), and the message names the
 * missing permission as 'rak_<id>'. So:
 *   controls  the manifest's `denied` requests go first. Each names a permission the key lacks and
 *             must come back 403 naming it: the permission is checked before the object is looked
 *             up (a payout that does not exist) and before the request is validated (a negative
 *             amount). Neither can create anything. If one is not refused, no refusal below can be
 *             read, so the writes are not sent.
 *   writes    every write the server makes, sent so that Stripe must refuse it on validity or
 *             existence: a checkout session with an invalid return URL (through the builder), and
 *             the portal, customer, balance and webhook-endpoint writes on ids that do not exist.
 *             400/404 = the key is permitted; 403 = it is not. A write Stripe ACCEPTS is FAIL and
 *             stops the run: disclose it, do not clean it up.
 *   reads     real and read-only, every expansion the server asks for checked to come back as an
 *             object. Discovery reads pick the ids the later reads need.
 * The live webhook endpoint's enabled_events are read before the writes and after the reads, and
 * must be the same set.
 *
 * CODE ROWS. A read can fail because the code asks for something the pinned API version removed,
 * not because the key lacks a permission. A row marked for it reports CODE: it proves nothing, it
 * does not fail the key, and it is counted in STRIPE_RAK_SMOKE_CODE_DEFECTS for the code's owner.
 * A 403 on it is still a key defect (FAIL).
 *
 * Usage, on signal-1 (the access policy refuses the key anywhere else), the key passed in the env:
 *   docker compose run --rm -T --no-deps -e STRIPE_SECRET_KEY -e TELEGRAM_BOT_TOKEN= -e TELEGRAM_CHAT_ID= \
 *     mcp-server node dist/scripts/stripe-rak-smoke.js --manifest - < ops/stripe-rak-permissions.json
 *   node dist/scripts/stripe-rak-smoke.js --self-test
 * The image carries no copy of the manifest, so it comes in on stdin (`-`) or as a path. The live run runs
 * the self-test first and sends nothing unless it passes.
 *
 * Output: the manifest's sha256 (16 hex) and the key as its first 8 characters and last 4; one line
 * per row; then STRIPE_RAK_SMOKE_COVERAGE, STRIPE_RAK_SMOKE_ENABLED_EVENTS,
 * STRIPE_RAK_SMOKE_CODE_ROWS=<ids|none>, STRIPE_RAK_SMOKE_CODE_DEFECTS=<n> and exactly one terminal
 * STRIPE_RAK_SMOKE_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 1 / 3; FAIL > INDETERMINATE > PASS).
 * PASS needs every row PASS or CODE, and every granted permission proven by a PASS row. Nothing a row
 * reads is printed: no object content, customer field or email; keys and ids are masked.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runScript } from '../lib/script-lifecycle.js';
import {
  countActiveSubscriptionsByTier,
  createBillingPortalSession,
  createCheckoutSession,
  fetchPaymentMethodForSession,
  getStripeClient,
  validateApiKey,
} from '../lib/stripe.js';

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
type RowVerdict = Verdict | 'CODE';
type Kind = 'control' | 'write' | 'read';
type CheckResult = 'ok' | 'fail' | 'absent' | 'code';

const CODES: Record<Verdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** A response Stripe sent, as the client's 'response' event reports it. */
export interface Seen {
  request: string;
  status: number;
  requestId: string | null;
}

/** A thrown error, reduced to what classification reads. The message is masked. */
export interface Refusal {
  status: number | null;
  code: string | null;
  param: string | null;
  message: string;
  requestId: string | null;
}

/** Everything one row produced: what it expected, what Stripe answered, and its own check. */
export interface Observation {
  kind: Kind;
  expected: string[];
  paged: boolean;
  seen: Seen[];
  errors: Refusal[];
  logs: string[];
  check?: CheckResult;
  detail?: string;
  skipped?: string;
  /** control: the permission Stripe must name. */
  permission?: string;
  /** read: a 400 refusing the expansion, or a field the API version removed, is CODE. */
  codeOnExpand?: boolean;
  /** write: the refusal codes the row was built to draw. */
  planned?: string[];
}

export interface Outcome {
  verdict: RowVerdict;
  why: string;
  accepted?: true;
}

// ── masking ──────────────────────────────────────────────────────────────────

/**
 * Stripe keys to their first 8 characters and last 4, AlgoVault keys of every kind to their prefix
 * and last 4, object ids to their prefix and last 4, emails dropped. Request ids, permission names
 * and the smoke's own synthetic ids stay whole.
 */
export function mask(text: string): string {
  return text
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9*]{4,}/g, (k) => `${k.slice(0, 8)}…${k.slice(-4)}`)
    .replace(/\bav_([a-z]+)_[A-Za-z0-9_]{4,}/g, (k, kind: string) => `av_${kind}_…${k.slice(-4)}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b([a-z]{2,6}_(?:(?:live|test)_)?)([A-Za-z0-9]{8,})\b/g, (m, p: string, id: string) =>
      p === 'req_' ? m : `${p}…${id.slice(-4)}`,
    );
}

/** The permissions a refusal names: Stripe writes them as 'rak_<id>'. */
export function rakNames(texts: string[]): string[] {
  const names = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\brak_([a-z][a-z0-9_]*[a-z0-9])/g)) names.add(m[1]);
  return [...names].sort();
}

/** A thrown Stripe error (statusCode, code, param, requestId) or anything else, as a Refusal. */
export function refusalOf(err: unknown): Refusal {
  const e = (err !== null && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    status: typeof e.statusCode === 'number' ? e.statusCode : null,
    code: str(e.code),
    param: str(e.param),
    message: mask(err instanceof Error ? err.message : String(err)),
    requestId: str(e.requestId),
  };
}

// ── requests ─────────────────────────────────────────────────────────────────

/** The request a response event names, in the manifest's form: `GET /v1/subscriptions`. */
export function requestOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split('?')[0]}`;
}

/** `GET /v1/invoices/{id}` matches `GET /v1/invoices/in_1`: a `{…}` segment stands for one non-empty segment. */
export function sameRequest(template: string, request: string): boolean {
  const [tv, tp = ''] = template.split(' ');
  const [rv, rp = ''] = request.split(' ');
  const t = tp.split('/');
  const r = rp.split('/');
  return tv === rv && t.length === r.length && t.every((s, i) => (/^\{[^}]*\}$/.test(s) ? r[i] !== '' : s === r[i]));
}

/** Stripe answered exactly the requests the row expects, in order; a paged row repeats its one request. */
export function matches(expected: string[], paged: boolean, seen: string[]): boolean {
  if (paged) return expected.length === 1 && seen.length > 0 && seen.every((s) => sameRequest(expected[0], s));
  return seen.length === expected.length && seen.every((s, i) => sameRequest(expected[i], s));
}

/** Two lists hold the same set. */
export function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The key's class when it is a restricted key, else null. */
export function keyClass(key: string): string | null {
  return /^rk_(?:live|test)_[A-Za-z0-9]{20,}$/.test(key) ? key.slice(0, 8) : null;
}

// ── the manifest ─────────────────────────────────────────────────────────────

export interface Denied {
  request: string;
  permission: string;
  params: Record<string, string | number | boolean> | null;
}

export interface Manifest {
  sha16: string;
  granted: string[];
  endpoints: Map<string, string>;
  fields: Map<string, string>;
  denied: Denied[];
}

const PERMISSION = /^[a-z][a-z0-9_]*_(?:read|write)$/;
const REQUEST = /^(GET|POST|DELETE) (\/v1(?:\/[A-Za-z0-9_.{}-]+)+)$/;

/** `{id}`, `{customer}` → `{}`: the form in which requests are looked up. */
const shapeOf = (request: string): string => request.replace(/\{[^}]*\}/g, '{}');

/** A grant covers its own permission, and a write grant covers the read of the same resource. */
export function covers(granted: string[], permission: string): boolean {
  return granted.includes(permission) || (permission.endsWith('_read') && granted.includes(`${permission.slice(0, -5)}_write`));
}

const plainParams = (p: unknown): boolean =>
  p !== null && typeof p === 'object' && !Array.isArray(p) && Object.values(p).every((x) => ['string', 'number', 'boolean'].includes(typeof x));

/** The manifest, or why it cannot be used. Only what the smoke needs is read; anything malformed is refused. */
export function parseManifest(text: string): Manifest | string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return 'the manifest is not JSON';
  }
  const granted: unknown = m?.key?.granted;
  if (!Array.isArray(granted) || !granted.length || !granted.every((p) => typeof p === 'string' && PERMISSION.test(p))) {
    return 'key.granted must be a non-empty list of permission ids';
  }
  if (!Array.isArray(m.endpoints) || !m.endpoints.length) return 'endpoints must be a non-empty list';
  const endpoints = new Map<string, string>();
  for (const e of m.endpoints) {
    if (typeof e?.request !== 'string' || !REQUEST.test(e.request) || typeof e.permission !== 'string' || !PERMISSION.test(e.permission)) {
      return 'every endpoints row needs a request ("VERB /v1/…") and a permission id';
    }
    endpoints.set(shapeOf(e.request), e.permission);
  }
  const f: unknown = m.expand_fields;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every((p) => typeof p === 'string' && PERMISSION.test(p))) {
    return 'expand_fields must map field names to permission ids';
  }
  if (!Array.isArray(m.denied) || !m.denied.length) return 'denied must be a non-empty list: without controls no refusal can be read';
  const denied: Denied[] = [];
  for (const d of m.denied) {
    const ok =
      typeof d?.request === 'string' && REQUEST.test(d.request) && !d.request.includes('{') &&
      typeof d.permission === 'string' && PERMISSION.test(d.permission) && d.expect === 403 &&
      (d.params === undefined || (plainParams(d.params) && d.request.startsWith('POST ')));
    if (!ok) return 'every denied entry needs a request sent as written, a permission id, expect 403, and params (POST only) of plain values';
    if (covers(granted, d.permission)) return `the denied request ${d.request} names ${d.permission}, which the key holds`;
    denied.push({ request: d.request, permission: d.permission, params: d.params ?? null });
  }
  return {
    sha16: createHash('sha256').update(text).digest('hex').slice(0, 16),
    granted: [...granted].sort(),
    endpoints,
    fields: new Map(Object.entries(f as Record<string, string>)),
    denied,
  };
}

/** What a row's requests and expansions need, from the manifest; `missing` names the first it has no row for. */
export function permissionsOf(
  requests: string[],
  expand: string[],
  man: Pick<Manifest, 'endpoints' | 'fields'>,
): { proves: string[] } | { missing: string } {
  const out = new Set<string>();
  for (const r of requests) {
    const p = man.endpoints.get(shapeOf(r));
    if (!p) return { missing: r };
    out.add(p);
  }
  for (const path of expand) {
    for (const seg of path.split('.')) {
      if (seg === 'data') continue; // the list cursor needs nothing
      const p = man.fields.get(seg);
      if (!p) return { missing: `expand ${path}` };
      out.add(p);
    }
  }
  return { proves: [...out].sort() };
}

// ── classification ───────────────────────────────────────────────────────────

const ok2xx = (s: number): boolean => s >= 200 && s < 300;

/** An expansion came back as the object asked for (ok), as a bare id (fail: not expanded), or not at all (absent). */
export function expanded(v: unknown, object: string): CheckResult {
  if (typeof v === 'string') return 'fail';
  if (v !== null && typeof v === 'object' && (v as { object?: unknown }).object === object) return 'ok';
  return 'absent';
}

/** Two checks of one row: a fail wins, then an absence. */
export const both = (a: CheckResult, b: CheckResult): CheckResult =>
  a === 'fail' || b === 'fail' ? 'fail' : a === 'absent' || b === 'absent' ? 'absent' : a === 'code' || b === 'code' ? 'code' : 'ok';

/**
 * What one row's responses prove. The branches run in precedence order: a row that could not be
 * read, then an authentication refusal, then a permission refusal, then Stripe's own trouble, and
 * only then what the row's kind makes of the rest.
 */
export function classify(o: Observation): Outcome {
  if (o.skipped) return { verdict: 'INDETERMINATE', why: `skipped: ${o.skipped}` };
  const first = o.errors[0];
  if (!o.seen.length) {
    const more = [o.detail, first && `${first.status ?? 'no status'} ${first.message}`].filter(Boolean).join('; ');
    return { verdict: 'INDETERMINATE', why: `no response from Stripe${more ? `: ${more}` : ''}` };
  }
  const sent = o.seen.map((s) => s.request);
  if (!matches(o.expected, o.paged, sent)) {
    return { verdict: 'INDETERMINATE', why: `sent ${sent.join(', ')}; the row expects ${o.expected.join(', ')}${o.paged ? ' (paged)' : ''}` };
  }
  const statuses = o.seen.map((s) => s.status);
  const named = rakNames([...o.errors.map((e) => e.message), ...o.logs]);

  if (statuses.includes(401)) {
    return { verdict: 'INDETERMINATE', why: '401: Stripe did not take the key here (the wrong key, or the access policy refused this host: measure the egress IP)' };
  }
  if (statuses.includes(403)) {
    if (o.kind === 'control') {
      return o.permission && named.includes(o.permission)
        ? { verdict: 'PASS', why: `refused, naming ${o.permission}` }
        : { verdict: 'INDETERMINATE', why: `403 naming ${named.join(', ') || 'no permission'}, not ${o.permission}: fix the denied entry` };
    }
    return named.length
      ? { verdict: 'FAIL', why: `the key lacks ${named.map((n) => `rak_${n}`).join(', ')} (edit the key, then re-run)` }
      : { verdict: 'INDETERMINATE', why: '403 naming no permission (an access-policy refusal? measure the egress IP)' };
  }
  if (statuses.some((s) => s === 429 || s >= 500)) {
    return { verdict: 'INDETERMINATE', why: `Stripe answered ${statuses.join(',')}: re-run` };
  }

  if (o.kind === 'control' || o.kind === 'write') {
    if (statuses.some(ok2xx)) {
      return { verdict: 'FAIL', accepted: true, why: `ACCEPTED (${statuses.join(',')}): Stripe did what this row was built to be refused. Disclose it, do not clean it up` };
    }
    if (o.kind === 'control') {
      return { verdict: 'INDETERMINATE', why: `not refused (${statuses.join(',')}), so the key may hold ${o.permission} and no refusal below can be read` };
    }
    if (!statuses.every((s) => s === 400 || s === 404)) {
      return { verdict: 'INDETERMINATE', why: `answered ${statuses.join(',')}: neither a refusal on validity (400) nor on existence (404)` };
    }
    if (!o.errors.length) return { verdict: 'INDETERMINATE', why: 'refused, but no error reached the row to say why' };
    for (const e of o.errors) {
      if (!e.code) return { verdict: 'INDETERMINATE', why: `refused (${e.status ?? 'no status'}) with no error code: ${e.message}` };
      if (e.code === 'parameter_unknown') {
        return { verdict: 'INDETERMINATE', why: `refused on an unknown parameter (${e.param ?? '?'}), which may be checked before the permission` };
      }
      if (e.status === 404 && e.code !== 'resource_missing') return { verdict: 'INDETERMINATE', why: `404 ${e.code}: the route may be unknown` };
    }
    const codes = [...new Set(o.errors.map((e) => e.code as string))];
    const unplanned = codes.some((c) => !(o.planned ?? []).includes(c));
    return {
      verdict: 'PASS',
      why: `refused on validity or existence: ${statuses.join(',')} ${codes.join(',')}${unplanned ? ' (not the planned refusal; still past the permission check)' : ''}`,
    };
  }

  // a read
  if (statuses.includes(400)) {
    const text = [...o.errors.flatMap((e) => [e.message, e.param ?? '']), ...o.logs].join(' ');
    return o.codeOnExpand && /expand/i.test(text)
      ? { verdict: 'CODE', why: `400 refusing the expansion: a code defect, not a permission (${first?.message ?? 'see the log'})` }
      : { verdict: 'INDETERMINATE', why: `400 on a read: ${first?.message ?? 'no error reached the row'}` };
  }
  if (!statuses.every(ok2xx)) return { verdict: 'INDETERMINATE', why: `answered ${statuses.join(',')} on a read` };
  switch (o.check) {
    case 'ok':
      return { verdict: 'PASS', why: o.detail ?? 'read' };
    case 'fail':
      return { verdict: 'FAIL', why: o.detail ?? 'an expansion came back as a bare id' };
    case 'code':
      return o.codeOnExpand
        ? { verdict: 'CODE', why: o.detail ?? 'a field the code reads is not in this API version' }
        : { verdict: 'INDETERMINATE', why: `${o.detail ?? 'a field is missing'} (this row is not one that may report CODE)` };
    default:
      return { verdict: 'INDETERMINATE', why: o.detail ?? (first ? `the row stopped: ${first.message}` : 'the row could not check what it read') };
  }
}

// ── the verdict ──────────────────────────────────────────────────────────────

/** The granted permissions no PASS row proved. A control proves nothing about the grants, and a CODE row proves nothing at all. */
export function coverage(granted: string[], rows: { kind: Kind; verdict: RowVerdict; proves: string[] }[]): string[] {
  const proven = new Set(rows.filter((r) => r.kind !== 'control' && r.verdict === 'PASS').flatMap((r) => r.proves));
  return granted.filter((p) => !proven.has(p));
}

/** FAIL > INDETERMINATE > PASS. CODE fails nothing; an unproven grant, or no rows at all, is INDETERMINATE. */
export function overall(rows: { verdict: RowVerdict }[], missing: string[]): Verdict {
  if (rows.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (!rows.length || missing.length || rows.some((r) => r.verdict === 'INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}

// ── the rows ─────────────────────────────────────────────────────────────────

type Client = NonNullable<ReturnType<typeof getStripeClient>>;
type Done = Pick<Observation, 'check' | 'detail' | 'skipped'>;

/** The ids the discovery reads pick for the reads after them. Held in memory only, never printed. */
interface Found {
  subId?: string;
  invoiceId?: string;
  subPmId?: string;
  piId?: string;
  csId?: string;
}

interface Ctx {
  client: Client;
  found: Found;
  before: string[] | null;
  after: string[] | null;
}

export interface Row {
  id: string;
  kind: Kind;
  /** What sends it: the server's builder, or the server's call mirrored, and where the server makes it. */
  how: string;
  /** The requests the row sends, in order, in the manifest's form. */
  expected: string[];
  paged?: boolean;
  expand?: string[];
  permission?: string;
  planned?: string[];
  codeOnExpand?: boolean;
  run(ctx: Ctx): Promise<Done>;
}

const ENDPOINT_URL = 'https://api.algovault.com/webhooks/stripe'; // = ENDPOINT_URL in src/lib/referral-accrual.ts (not exported)
const MISSING_CUSTOMER = 'cus_rak_smoke_missing'; // Stripe never mints an id with an underscore after its prefix
const MISSING_ENDPOINT = 'we_rak_smoke_missing';
const INVALID_BASE_URL = 'rak smoke not a url'; // no scheme, and spaces: success_url and cancel_url are both invalid
const UNHELD_KEY = 'av_live_raksmoke_no_such_key'; // passes validateApiKey's shape check; no customer holds it
const PORTAL_RETURN_URL = 'https://algovault.com/account';
const MARK = { smoke_check: 'refused' };

interface Capture {
  kind: Kind;
  seen: Seen[];
  errors: Refusal[];
  logs: string[];
}

/** The row being run. The client's 'response' listener and the console hook write into it. */
let current: Capture | null = null;

/**
 * Sends one step of a row. A thrown error is recorded, not raised. Once a control or a write has
 * been accepted, the row sends nothing more: an accepted change is never repeated.
 */
async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const c = current;
  if (c && c.kind !== 'read' && c.seen.some((s) => ok2xx(s.status))) return undefined;
  try {
    return await fn();
  } catch (err) {
    c?.errors.push(refusalOf(err));
    return undefined;
  }
}

const findings = (f: Record<string, unknown>): string =>
  Object.entries(f).map(([k, v]) => `${k} ${v ? 'yes' : 'no'}`).join(', ');

const via = (a: unknown): CheckResult => (a ? 'ok' : 'absent');

/** Every row, in the order it runs: the controls, the endpoint baseline, the writes, the reads, the endpoint again. */
export function rowsFor(man: Pick<Manifest, 'denied'>): Row[] {
  const controls: Row[] = man.denied.map((d, i) => {
    const [verb, path] = d.request.split(' ');
    return {
      id: `C${i + 1}`,
      kind: 'control',
      how: `rawRequest ${d.request} (the manifest's denied list)`,
      expected: [d.request],
      permission: d.permission,
      run: async ({ client }) => {
        await call(() => client.rawRequest(verb, path, d.params ?? undefined));
        return {};
      },
    };
  });
  const endpointEvents = (label: 'before' | 'after') => async (ctx: Ctx): Promise<Done> => {
    const list = await call(() => ctx.client.webhookEndpoints.list({ limit: 100 }));
    if (!list) return {};
    const ep = list.data.find((e) => e.url === ENDPOINT_URL);
    if (label === 'before') {
      if (!ep) return { check: 'absent', detail: 'the live webhook endpoint is not in the list' };
      ctx.before = [...ep.enabled_events];
      return { check: 'ok', detail: `the live endpoint: ${ep.enabled_events.length} enabled events` };
    }
    if (!ep) return ctx.before ? { check: 'fail', detail: 'the live webhook endpoint is gone' } : { check: 'absent', detail: 'no endpoint, before or after' };
    ctx.after = [...ep.enabled_events];
    if (!ctx.before) return { check: 'absent', detail: 'R6 read no baseline' };
    return sameSet(ctx.before, ctx.after)
      ? { check: 'ok', detail: `enabled_events unchanged (${ctx.after.length})` }
      : { check: 'fail', detail: `enabled_events changed: ${ctx.before.length} before, ${ctx.after.length} after` };
  };
  return [
    ...controls,
    { id: 'R6', kind: 'read', how: 'mirror webhookEndpoints.list (src/lib/referral-accrual.ts): the enabled_events baseline', expected: ['GET /v1/webhook_endpoints'], run: endpointEvents('before') },
    {
      id: 'W1', kind: 'write', how: 'builder createCheckoutSession (src/lib/stripe.ts), the base URL invalid',
      expected: ['POST /v1/checkout/sessions'], planned: ['url_invalid'],
      run: async () => {
        const url = await call(() => createCheckoutSession('starter', INVALID_BASE_URL));
        return url === null ? { detail: 'the builder sent nothing: no starter price is configured' } : {};
      },
    },
    {
      id: 'W2', kind: 'write', how: 'builder createBillingPortalSession (src/lib/stripe.ts), then mirrored for its error code; no such customer',
      expected: ['POST /v1/billing_portal/sessions', 'POST /v1/billing_portal/sessions'], planned: ['resource_missing'],
      run: async ({ client }) => {
        await call(() => createBillingPortalSession({ customerId: MISSING_CUSTOMER, returnUrl: PORTAL_RETURN_URL }));
        await call(() => client.billingPortal.sessions.create({ customer: MISSING_CUSTOMER, return_url: PORTAL_RETURN_URL }));
        return {};
      },
    },
    {
      id: 'W3', kind: 'write', how: 'mirror customers.update (src/lib/stripe.ts); no such customer',
      expected: ['POST /v1/customers/{id}'], planned: ['resource_missing'],
      run: async ({ client }) => {
        await call(() => client.customers.update(MISSING_CUSTOMER, { metadata: MARK }));
        return {};
      },
    },
    {
      id: 'W4', kind: 'write', how: 'mirror customers.createBalanceTransaction (src/lib/referral-accrual.ts); no such customer',
      expected: ['POST /v1/customers/{id}/balance_transactions'], planned: ['resource_missing'],
      run: async ({ client }) => {
        await call(() => client.customers.createBalanceTransaction(MISSING_CUSTOMER, { amount: -1, currency: 'usd', description: 'rak smoke: refused, no such customer' }));
        return {};
      },
    },
    {
      id: 'W5', kind: 'write', how: 'mirror webhookEndpoints.update (src/lib/referral-accrual.ts); no such endpoint',
      expected: ['POST /v1/webhook_endpoints/{id}'], planned: ['resource_missing'],
      run: async ({ client }) => {
        await call(() => client.webhookEndpoints.update(MISSING_ENDPOINT, { metadata: MARK }));
        return {};
      },
    },
    {
      id: 'R1', kind: 'read', how: 'builder validateApiKey (src/lib/stripe.ts), a key no customer holds',
      expected: ['GET /v1/customers/search'],
      run: async () => {
        const v = await call(() => validateApiKey(UNHELD_KEY));
        if (!v) return {};
        return v.entitlementState === 'NOT_ENTITLED' && v.reason === 'no_customer'
          ? { check: 'ok', detail: 'searched: no customer holds the key, as expected' }
          : { check: 'absent', detail: `the builder answered ${v.entitlementState ?? '?'}/${v.reason ?? '?'}` };
      },
    },
    {
      id: 'R2', kind: 'read', how: 'builder countActiveSubscriptionsByTier (src/lib/stripe.ts), every page',
      expected: ['GET /v1/subscriptions'], paged: true,
      run: async () => {
        const c = await call(() => countActiveSubscriptionsByTier());
        if (!c) return {};
        return c.source === 'stripe_live' ? { check: 'ok', detail: 'the census read every page' } : { check: 'absent', detail: `the census came from ${c.source}` };
      },
    },
    {
      id: 'R3', kind: 'read', how: 'mirror subscriptions.list status=all (src/lib/subscriber-attribution.ts); picks the ids X2, X2c and X3 read',
      expected: ['GET /v1/subscriptions'],
      run: async (ctx) => {
        const list = await call(() => ctx.client.subscriptions.list({ status: 'all', limit: 100 }));
        if (!list) return {};
        ctx.found.subId = list.data[0]?.id;
        ctx.found.invoiceId = list.data.map((s) => s.latest_invoice).find((v): v is string => typeof v === 'string');
        ctx.found.subPmId = list.data.find((s) => typeof s.default_payment_method === 'string')?.id;
        const f = ctx.found;
        return { check: 'ok', detail: `listed; found ${findings({ 'a subscription': f.subId, 'an invoice': f.invoiceId, 'a default payment method': f.subPmId })}` };
      },
    },
    {
      id: 'R4', kind: 'read', how: 'mirror charges.list (src/lib/payment-method-backfill.ts); picks the payment intent X1 reads',
      expected: ['GET /v1/charges'],
      run: async (ctx) => {
        const list = await call(() => ctx.client.charges.list({ limit: 100 }));
        if (!list) return {};
        const pi = list.data.find((c) => c.status === 'succeeded' && typeof c.payment_intent === 'string')?.payment_intent;
        ctx.found.piId = typeof pi === 'string' ? pi : undefined;
        return { check: 'ok', detail: `listed; found ${findings({ 'a payment intent': ctx.found.piId })}` };
      },
    },
    {
      id: 'R5', kind: 'read', how: "mirror invoices.list status=open (validateApiKey's collection leg, src/lib/stripe.ts)",
      expected: ['GET /v1/invoices'],
      run: async (ctx) => {
        const sub = ctx.found.subId;
        if (!sub) return { skipped: 'R3 found no subscription' };
        const list = await call(() => ctx.client.invoices.list({ subscription: sub, status: 'open', limit: 100 }));
        return list ? { check: 'ok', detail: 'listed' } : {};
      },
    },
    {
      id: 'R7', kind: 'read', how: 'mirror GET /v1/checkout/sessions (scripts/measure-activation-soak.mjs); picks the session R8 reads',
      expected: ['GET /v1/checkout/sessions'],
      run: async (ctx) => {
        const list = await call(() => ctx.client.checkout.sessions.list({ status: 'complete', limit: 100 }));
        if (!list) return {};
        ctx.found.csId = list.data.find((s) => s.mode === 'subscription' && typeof s.customer === 'string' && typeof s.subscription === 'string')?.id;
        return { check: 'ok', detail: `listed; found ${findings({ 'a completed subscription session': ctx.found.csId })}` };
      },
    },
    {
      id: 'R8', kind: 'read', how: 'mirror checkout.sessions.retrieve (src/lib/stripe.ts getCustomerApiKey)',
      expected: ['GET /v1/checkout/sessions/{id}'], expand: ['customer', 'subscription'],
      run: async (ctx) => {
        const id = ctx.found.csId;
        if (!id) return { skipped: 'R7 found no completed subscription session' };
        const s = await call(() => ctx.client.checkout.sessions.retrieve(id, { expand: ['customer', 'subscription'] }));
        if (!s) return {};
        const c = expanded(s.customer, 'customer');
        const sub = expanded(s.subscription, 'subscription');
        return { check: both(c, sub), detail: `customer ${c}, subscription ${sub}` };
      },
    },
    {
      id: 'X1', kind: 'read', how: 'builder fetchPaymentMethodForSession path 1 (src/lib/stripe.ts), then its request mirrored',
      expected: ['GET /v1/payment_intents/{id}', 'GET /v1/payment_intents/{id}'], expand: ['latest_charge'],
      run: async (ctx) => {
        const id = ctx.found.piId;
        if (!id) return { skipped: 'R4 found no succeeded charge with a payment intent' };
        const a = await call(() => fetchPaymentMethodForSession({ payment_intent: id }));
        const pi = await call(() => ctx.client.paymentIntents.retrieve(id, { expand: ['latest_charge'] }));
        if (!pi) return {};
        const e = expanded(pi.latest_charge, 'charge');
        return { check: both(via(a), e), detail: `the builder ${a ? 'attributed it' : 'returned null'}; latest_charge ${e}` };
      },
    },
    {
      id: 'X2', kind: 'read', codeOnExpand: true, how: 'builder fetchPaymentMethodForSession path 2 (src/lib/stripe.ts), then its request mirrored',
      expected: ['GET /v1/invoices/{id}', 'GET /v1/invoices/{id}'], expand: ['payment_intent.latest_charge'],
      run: async (ctx) => {
        const id = ctx.found.invoiceId;
        if (!id) return { skipped: 'R3 found no invoice' };
        const a = await call(() => fetchPaymentMethodForSession({ invoice: id }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inv: any = await call(() => ctx.client.invoices.retrieve(id, { expand: ['payment_intent.latest_charge'] }));
        if (!inv) return {};
        if (!('payment_intent' in inv)) {
          return { check: 'code', detail: '200, and the Invoice has no payment_intent field (removed in basil): path 2 can never find the charge' };
        }
        const pi = inv.payment_intent;
        if (pi === null) return { check: 'absent', detail: 'this invoice has no payment intent' };
        if (typeof pi === 'string') return { check: 'fail', detail: 'payment_intent came back as a bare id' };
        const e = expanded(pi.latest_charge, 'charge');
        return { check: both(via(a), e), detail: `the builder ${a ? 'attributed it' : 'returned null'}; payment_intent.latest_charge ${e}` };
      },
    },
    {
      id: 'X2c', kind: 'read', how: 'invoices.retrieve, no expansion: proves invoice_read apart from X2',
      expected: ['GET /v1/invoices/{id}'],
      run: async (ctx) => {
        const id = ctx.found.invoiceId;
        if (!id) return { skipped: 'R3 found no invoice' };
        const inv = await call(() => ctx.client.invoices.retrieve(id));
        if (!inv) return {};
        return inv.object === 'invoice' ? { check: 'ok', detail: 'read' } : { check: 'absent', detail: 'the answer is not an invoice' };
      },
    },
    {
      id: 'X3', kind: 'read', how: 'builder fetchPaymentMethodForSession path 3 (src/lib/stripe.ts), then its request mirrored',
      expected: ['GET /v1/subscriptions/{id}', 'GET /v1/subscriptions/{id}'], expand: ['default_payment_method'],
      run: async (ctx) => {
        const id = ctx.found.subPmId;
        if (!id) return { skipped: 'R3 found no subscription with a default payment method' };
        const a = await call(() => fetchPaymentMethodForSession({ subscription: id }));
        const sub = await call(() => ctx.client.subscriptions.retrieve(id, { expand: ['default_payment_method'] }));
        if (!sub) return {};
        const e = expanded(sub.default_payment_method, 'payment_method');
        return { check: both(via(a), e), detail: `the builder ${a ? 'attributed it' : 'returned null'}; default_payment_method ${e}` };
      },
    },
    { id: 'E', kind: 'read', how: 'webhookEndpoints.list again: enabled_events must be the set R6 read', expected: ['GET /v1/webhook_endpoints'], run: endpointEvents('after') },
  ];
}

// ── self-test ────────────────────────────────────────────────────────────────

const SELF_TEST_MIN_CHECKS = 112;

/** Shaped like ops/stripe-rak-permissions.json: its grants, and a row for every request and expansion the smoke sends. */
const ST_MANIFEST = {
  key: {
    granted: [
      'charge_read', 'checkout_session_write', 'customer_portal_write', 'customer_write', 'invoice_read',
      'payment_intent_read', 'payment_method_read', 'subscription_read', 'webhook_write',
    ],
  },
  endpoints: [
    { request: 'GET /v1/charges', permission: 'charge_read' },
    { request: 'GET /v1/checkout/sessions', permission: 'checkout_session_read' },
    { request: 'GET /v1/checkout/sessions/{id}', permission: 'checkout_session_read' },
    { request: 'GET /v1/customers/search', permission: 'customer_read' },
    { request: 'GET /v1/invoices', permission: 'invoice_read' },
    { request: 'GET /v1/invoices/{id}', permission: 'invoice_read' },
    { request: 'GET /v1/payment_intents/{id}', permission: 'payment_intent_read' },
    { request: 'GET /v1/subscriptions', permission: 'subscription_read' },
    { request: 'GET /v1/subscriptions/{id}', permission: 'subscription_read' },
    { request: 'GET /v1/webhook_endpoints', permission: 'webhook_read' },
    { request: 'POST /v1/billing_portal/sessions', permission: 'customer_portal_write' },
    { request: 'POST /v1/checkout/sessions', permission: 'checkout_session_write' },
    { request: 'POST /v1/customers/{id}', permission: 'customer_write' },
    { request: 'POST /v1/customers/{id}/balance_transactions', permission: 'customer_write' },
    { request: 'POST /v1/webhook_endpoints/{id}', permission: 'webhook_write' },
  ],
  expand_fields: {
    customer: 'customer_read', default_payment_method: 'payment_method_read', latest_charge: 'charge_read',
    payment_intent: 'payment_intent_read', subscription: 'subscription_read',
  },
  denied: [
    { request: 'GET /v1/payouts/po_st_missing', permission: 'payout_read', expect: 403, proves: 'checked before the lookup' },
    { request: 'POST /v1/payouts', params: { amount: -1, currency: 'usd' }, permission: 'payout_write', expect: 403, proves: 'checked before validation' },
  ],
};

/** The 403 message as Stripe words it, the key and account already starred by Stripe. */
const ST_RAK = (p: string): string =>
  `The provided key 'rk_live_*********************abcd' does not have the required permissions for this endpoint on account 'acct_1AbCdEfGhIjKlMnO'. Having the 'rak_${p}' permission would allow this request to continue.`;

/** Every helper and every classification branch, offline. Never sends a request. */
export function selfTest(): Verdict {
  const fails: string[] = [];
  let ran = 0;
  const check1 = (name: string, fn: () => boolean): void => {
    ran++;
    try {
      if (fn() !== true) fails.push(name);
    } catch (err) {
      fails.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const seen = (request: string, ...statuses: number[]): Seen[] => statuses.map((status) => ({ request, status, requestId: null }));
  const err = (status: number | null, code: string | null, message = 'refused', param: string | null = null): Refusal => ({ status, code, param, message, requestId: null });
  type Part = Partial<Observation> & Pick<Observation, 'kind'>;
  const obs = (o: Part): Observation => ({ expected: ['GET /v1/charges'], paged: false, seen: seen('GET /v1/charges', 200), errors: [], logs: [], ...o });
  const v = (o: Part): RowVerdict => classify(obs(o)).verdict;
  const why = (o: Part): string => classify(obs(o)).why;
  const manifest = (patch: Record<string, unknown>): Manifest | string => parseManifest(JSON.stringify({ ...ST_MANIFEST, ...patch }));
  const deny = (patch: Record<string, unknown>): Manifest | string => manifest({ denied: [{ ...ST_MANIFEST.denied[0], ...patch }] });
  const parsed = parseManifest(JSON.stringify(ST_MANIFEST));
  const m = typeof parsed === 'string' ? null : parsed;

  // masking
  check1('mask: a restricted key to its first 8 and last 4', () => mask(`key rk_live_${'A'.repeat(24)}wxyz`) === 'key rk_live_…wxyz');
  check1('mask: a key Stripe starred', () => mask("'rk_live_*********************wxyz'") === "'rk_live_…wxyz'");
  check1('mask: a secret key', () => mask(`sk_live_${'B'.repeat(30)}1234`) === 'sk_live_…1234');
  check1('mask: an account id', () => mask('acct_1AbCdEfGhIjKlMnO') === 'acct_…lMnO');
  check1('mask: an email', () => mask('mail a.b@example.com now') === 'mail <email> now');
  check1('mask: an object id', () => mask('cus_AbCdEfGh12345678') === 'cus_…5678');
  check1('mask: a live session id', () => mask('cs_live_a1B2c3D4e5F6g7H8') === 'cs_live_…g7H8');
  check1('mask: a webhook secret', () => mask(`whsec_${'Ab'.repeat(8)}5678`) === 'whsec_…5678');
  check1('mask: an AlgoVault key', () => mask('av_live_raksmoke_no_such_key') === 'av_live_…_key');
  check1('mask: a free AlgoVault key', () => mask(`av_free_${'a1'.repeat(12)}`) === 'av_free_…a1a1');
  check1('mask: every AlgoVault key kind', () => mask(`av_oauth_${'b2'.repeat(12)}`) === 'av_oauth_…b2b2');
  check1('mask: keeps request ids, permission names and the synthetic ids', () => {
    const t = 'req_AbCdEfGh12345678 rak_customer_portal_write cus_rak_smoke_missing we_rak_smoke_missing po_rak_smoke_missing';
    return mask(t) === t;
  });
  check1('mask: a 403 message keeps the permission and hides the account', () => {
    const t = mask(ST_RAK('payout_read'));
    return t.includes("'rak_payout_read'") && t.includes('acct_…lMnO') && !t.includes('1AbCd');
  });

  // permission names
  check1('rakNames: reads the permission a 403 names', () => eq(rakNames([ST_RAK('customer_portal_write')]), ['customer_portal_write']));
  check1('rakNames: none named', () => eq(rakNames(['Forbidden', '']), []));
  check1('rakNames: sorted, each once', () => eq(rakNames(["'rak_b_read' and 'rak_a_write'", "'rak_b_read'"]), ['a_write', 'b_read']));

  // request matching
  check1('sameRequest: a placeholder matches one segment', () => sameRequest('GET /v1/invoices/{id}', 'GET /v1/invoices/in_1'));
  check1('sameRequest: not a different segment count', () => !sameRequest('GET /v1/invoices/{id}', 'GET /v1/invoices'));
  check1('sameRequest: not another verb', () => !sameRequest('GET /v1/invoices/{id}', 'POST /v1/invoices/in_1'));
  check1('sameRequest: not another path', () => !sameRequest('GET /v1/charges', 'GET /v1/refunds'));
  check1('sameRequest: a placeholder never matches an empty segment', () => !sameRequest('GET /v1/invoices/{id}', 'GET /v1/invoices/'));
  check1('matches: a paged row repeats its request', () => matches(['GET /v1/subscriptions'], true, ['GET /v1/subscriptions', 'GET /v1/subscriptions']));
  check1('matches: a paged row sends nothing else', () => !matches(['GET /v1/subscriptions'], true, ['GET /v1/subscriptions', 'GET /v1/charges']));
  check1('matches: a paged row sends at least once', () => !matches(['GET /v1/subscriptions'], true, []));
  check1('matches: in order', () => !matches(['GET /v1/a', 'GET /v1/b'], false, ['GET /v1/b', 'GET /v1/a']));
  check1('matches: no extra request', () => !matches(['GET /v1/a'], false, ['GET /v1/a', 'GET /v1/a']));
  check1('requestOf: the query is dropped, the verb upper-cased', () => requestOf('get', '/v1/subscriptions?limit=100&status=all') === 'GET /v1/subscriptions');

  // the manifest
  check1('parseManifest: the fixture loads', () =>
    m !== null && m.granted.length === 9 && m.denied.length === 2 && m.sha16.length === 16 && m.denied[0].params === null && m.denied[1].params?.amount === -1);
  check1('parseManifest: not JSON', () => typeof parseManifest('{') === 'string');
  check1('parseManifest: no grants', () => typeof manifest({ key: { granted: [] } }) === 'string');
  check1('parseManifest: an endpoints row without a permission', () => typeof manifest({ endpoints: [{ request: 'GET /v1/charges' }] }) === 'string');
  check1('parseManifest: no denied list', () => typeof manifest({ denied: undefined }) === 'string');
  check1('parseManifest: a denied permission the key holds', () => typeof deny({ permission: 'charge_read' }) === 'string');
  check1('parseManifest: a denied permission a write grant covers', () => typeof deny({ permission: 'customer_read' }) === 'string');
  check1('parseManifest: a denied entry that does not expect 403', () => typeof deny({ expect: 404 }) === 'string');
  check1('parseManifest: a denied request with a placeholder', () => typeof deny({ request: 'GET /v1/payouts/{id}' }) === 'string');
  check1('parseManifest: params on a GET', () => typeof deny({ params: { amount: 1 } }) === 'string');
  check1('parseManifest: params that are not plain values', () =>
    typeof manifest({ denied: [{ ...ST_MANIFEST.denied[1], params: { amount: { x: 1 } } }] }) === 'string');
  check1('permissionsOf: requests and every segment of an expansion', () =>
    m !== null && eq(permissionsOf(['GET /v1/invoices/{id}', 'GET /v1/invoices/{id}'], ['payment_intent.latest_charge'], m), { proves: ['charge_read', 'invoice_read', 'payment_intent_read'] }));
  check1('permissionsOf: the list cursor needs nothing', () => m !== null && eq(permissionsOf(['GET /v1/charges'], ['data.customer'], m), { proves: ['charge_read', 'customer_read'] }));
  check1('permissionsOf: any placeholder name', () => m !== null && eq(permissionsOf(['POST /v1/customers/{customer}/balance_transactions'], [], m), { proves: ['customer_write'] }));
  check1('permissionsOf: an unmapped request', () => m !== null && eq(permissionsOf(['GET /v1/nowhere'], [], m), { missing: 'GET /v1/nowhere' }));
  check1('permissionsOf: an unmapped expansion', () => m !== null && eq(permissionsOf(['GET /v1/charges'], ['balance_transaction'], m), { missing: 'expand balance_transaction' }));
  check1('covers: a write grant covers its read', () => covers(['customer_write'], 'customer_read'));
  check1('covers: a read grant never covers its write', () => !covers(['customer_read'], 'customer_write'));

  // classification: what a row's responses prove
  const C = { kind: 'control' as const, expected: ['GET /v1/payouts/po_x'], permission: 'payout_read' };
  const ctl = (status: number, message = 'refused'): Part => ({ ...C, seen: seen('GET /v1/payouts/po_x', status), errors: status < 300 ? [] : [err(status, null, message)] });
  const W = { kind: 'write' as const, expected: ['POST /v1/customers/{id}'], planned: ['resource_missing'] };
  const wr = (status: number, errors: Refusal[] = []): Part => ({ ...W, seen: seen('POST /v1/customers/cus_x', status), errors });
  const R = { kind: 'read' as const, expected: ['GET /v1/invoices/{id}'] };
  const rd = (status: number, extra: Partial<Observation> = {}): Part => ({ ...R, seen: seen('GET /v1/invoices/in_x', status), ...extra });
  const EXPAND = 'This property cannot be expanded (payment_intent).';

  check1('classify: a skipped row', () => v({ kind: 'read', skipped: 'no id' }) === 'INDETERMINATE');
  check1('classify: no response', () => v({ kind: 'read', seen: [] }) === 'INDETERMINATE' && why({ kind: 'read', seen: [] }).startsWith('no response'));
  check1('classify: a request the row does not expect', () => v({ kind: 'read', seen: seen('GET /v1/refunds', 200), check: 'ok' }) === 'INDETERMINATE');
  check1('classify: 401', () => v(wr(401, [err(401, null, 'Invalid API Key provided')])) === 'INDETERMINATE');
  check1('classify: a control refused, naming its permission', () => v(ctl(403, ST_RAK('payout_read'))) === 'PASS');
  check1('classify: a control refused, naming another', () => v(ctl(403, ST_RAK('payout_write'))) === 'INDETERMINATE');
  check1('classify: a control refused, naming none', () => v(ctl(403, 'Forbidden')) === 'INDETERMINATE');
  check1('classify: a control not refused', () => v({ ...ctl(404), errors: [err(404, 'resource_missing')] }) === 'INDETERMINATE');
  check1('classify: a control accepted', () => {
    const o = classify(obs(ctl(200)));
    return o.verdict === 'FAIL' && o.accepted === true;
  });
  check1('classify: a write refused, naming the permission', () => v(wr(403, [err(403, null, ST_RAK('customer_write'))])) === 'FAIL');
  check1('classify: a write refused, naming none', () => v(wr(403, [err(403, null, 'Forbidden')])) === 'INDETERMINATE');
  check1('classify: a write refused, named only in the builder log', () => v({ ...wr(403), logs: [`Stripe createBillingPortalSession error: ${ST_RAK('customer_portal_write')}`] }) === 'FAIL');
  check1('classify: a write accepted', () => {
    const o = classify(obs(wr(200)));
    return o.verdict === 'FAIL' && o.accepted === true && o.why.startsWith('ACCEPTED');
  });
  check1('classify: a write refused on existence', () => v(wr(404, [err(404, 'resource_missing')])) === 'PASS');
  check1('classify: a write refused as planned', () => {
    const o = classify(obs({ ...wr(400, [err(400, 'url_invalid')]), planned: ['url_invalid'] }));
    return o.verdict === 'PASS' && !o.why.includes('not the planned');
  });
  check1('classify: a write refused otherwise, still past the permission', () => {
    const o = classify(obs(wr(400, [err(400, 'parameter_invalid_empty')])));
    return o.verdict === 'PASS' && o.why.includes('not the planned');
  });
  check1('classify: a write refused on an unknown parameter', () => v(wr(400, [err(400, 'parameter_unknown')])) === 'INDETERMINATE');
  check1('classify: a 404 that is not resource_missing', () => v(wr(404, [err(404, 'route_unknown')])) === 'INDETERMINATE');
  check1('classify: a refusal with no code', () => v(wr(400, [err(400, null)])) === 'INDETERMINATE');
  check1('classify: a refusal with no error', () => v(wr(400)) === 'INDETERMINATE');
  check1('classify: 500', () => v(wr(500, [err(500, null)])) === 'INDETERMINATE');
  check1('classify: 409 is neither refusal', () => v(wr(409, [err(409, 'idempotency_error')])) === 'INDETERMINATE');
  check1('classify: 429', () => v(wr(429, [err(429, 'rate_limit')])) === 'INDETERMINATE');
  check1('classify: the builder and its mirror, refused alike', () =>
    v({ kind: 'write', expected: ['POST /v1/billing_portal/sessions', 'POST /v1/billing_portal/sessions'], planned: ['resource_missing'],
      seen: seen('POST /v1/billing_portal/sessions', 400, 400), errors: [err(400, 'resource_missing')] }) === 'PASS');
  check1('classify: a read', () => v(rd(200, { check: 'ok' })) === 'PASS');
  check1('classify: a read with a bare id', () => v(rd(200, { check: 'fail' })) === 'FAIL');
  check1('classify: a read missing what it checks', () => v(rd(200, { check: 'absent' })) === 'INDETERMINATE');
  check1('classify: a read that checked nothing', () => v(rd(200)) === 'INDETERMINATE');
  check1('classify: CODE, a 400 refusing the expansion', () => v(rd(400, { codeOnExpand: true, errors: [err(400, null, EXPAND)] })) === 'CODE');
  check1('classify: CODE, the refusal only in the builder log', () => v(rd(400, { codeOnExpand: true, logs: [`[fetchPaymentMethodForSession] fail-open: ${EXPAND}`] })) === 'CODE');
  check1('classify: not CODE on a row that may not report it', () => v(rd(400, { errors: [err(400, null, EXPAND)] })) === 'INDETERMINATE');
  check1('classify: not CODE on a 400 about something else', () => v(rd(400, { codeOnExpand: true, errors: [err(400, null, 'Invalid string')] })) === 'INDETERMINATE');
  check1('classify: CODE, a field the version removed', () => v(rd(200, { codeOnExpand: true, check: 'code' })) === 'CODE');
  check1('classify: not CODE without the mark', () => v(rd(200, { check: 'code' })) === 'INDETERMINATE');
  check1('classify: a 403 on a CODE row is still the key', () => v(rd(403, { codeOnExpand: true, errors: [err(403, null, ST_RAK('invoice_read'))] })) === 'FAIL');
  check1('classify: a read answered 404', () => v(rd(404, { errors: [err(404, 'resource_missing')] })) === 'INDETERMINATE');
  check1('classify: a paged read', () => v({ kind: 'read', expected: ['GET /v1/subscriptions'], paged: true, seen: seen('GET /v1/subscriptions', 200, 200, 200), check: 'ok' }) === 'PASS');
  check1('classify: a paged read refused on a later page', () =>
    v({ kind: 'read', expected: ['GET /v1/subscriptions'], paged: true, seen: seen('GET /v1/subscriptions', 200, 403), logs: [ST_RAK('subscription_read')] }) === 'FAIL');

  // the verdict
  check1('coverage: every grant proven', () => eq(coverage(['a_read', 'b_write'], [{ kind: 'read', verdict: 'PASS', proves: ['a_read'] }, { kind: 'write', verdict: 'PASS', proves: ['b_write'] }]), []));
  check1('coverage: a control proves no grant', () => eq(coverage(['a_read'], [{ kind: 'control', verdict: 'PASS', proves: ['a_read'] }]), ['a_read']));
  check1('coverage: a CODE row proves nothing', () => eq(coverage(['a_read'], [{ kind: 'read', verdict: 'CODE', proves: ['a_read'] }]), ['a_read']));
  check1('coverage: a FAIL row proves nothing', () => eq(coverage(['a_read'], [{ kind: 'read', verdict: 'FAIL', proves: ['a_read'] }]), ['a_read']));
  check1('overall: every row PASS', () => overall([{ verdict: 'PASS' }, { verdict: 'PASS' }], []) === 'PASS');
  check1('overall: CODE fails nothing', () => overall([{ verdict: 'PASS' }, { verdict: 'CODE' }], []) === 'PASS');
  check1('overall: FAIL over INDETERMINATE', () => overall([{ verdict: 'INDETERMINATE' }, { verdict: 'FAIL' }], []) === 'FAIL');
  check1('overall: one INDETERMINATE row', () => overall([{ verdict: 'PASS' }, { verdict: 'INDETERMINATE' }], []) === 'INDETERMINATE');
  check1('overall: an unproven grant', () => overall([{ verdict: 'PASS' }], ['a_read']) === 'INDETERMINATE');
  check1('overall: no rows', () => overall([], []) === 'INDETERMINATE');

  // the small helpers
  check1('expanded: an object', () => expanded({ object: 'charge' }, 'charge') === 'ok');
  check1('expanded: a bare id', () => expanded('ch_1', 'charge') === 'fail');
  check1('expanded: nothing', () => expanded(null, 'charge') === 'absent');
  check1('expanded: another object', () => expanded({ object: 'invoice' }, 'charge') === 'absent');
  check1('both: fail, then absent, then code', () => both('ok', 'fail') === 'fail' && both('absent', 'ok') === 'absent' && both('code', 'ok') === 'code' && both('ok', 'ok') === 'ok');
  check1('sameSet: order and repeats do not matter', () => sameSet(['a', 'b'], ['b', 'a', 'a']));
  check1('sameSet: a member more', () => !sameSet(['a'], ['a', 'b']));
  check1('keyClass: a restricted key', () => keyClass(`rk_live_${'x'.repeat(20)}`) === 'rk_live_');
  check1('keyClass: not a secret key', () => keyClass(`sk_live_${'x'.repeat(30)}`) === null);
  check1('keyClass: not a short one', () => keyClass('rk_live_short') === null);
  check1('refusalOf: a Stripe error, its message masked', () => {
    const e = Object.assign(new Error("No such customer: 'cus_AbCdEfGh12345678'"), { statusCode: 404, code: 'resource_missing', param: 'id', requestId: 'req_abc' });
    return eq(refusalOf(e), { status: 404, code: 'resource_missing', param: 'id', message: "No such customer: 'cus_…5678'", requestId: 'req_abc' });
  });
  check1('refusalOf: anything else', () => eq(refusalOf('boom'), { status: null, code: null, param: null, message: 'boom', requestId: null }));

  // the rows
  const rows = m ? rowsFor(m) : [];
  const ids = rows.map((r) => r.id);
  const at = (id: string): number => ids.indexOf(id);
  const kinds = rows.map((r) => r.kind);
  check1('rows: the order', () => ids.join(' ') === 'C1 C2 R6 W1 W2 W3 W4 W5 R1 R2 R3 R4 R5 R7 R8 X1 X2 X2c X3 E');
  check1('rows: the controls first, then the baseline, then every write', () =>
    kinds.lastIndexOf('control') < at('R6') && at('R6') < kinds.indexOf('write') && kinds.lastIndexOf('write') < at('R1'));
  check1('rows: the controls are the denied list', () =>
    rows.filter((r) => r.kind === 'control').map((r) => `${r.expected[0]} ${r.permission}`).join('|') ===
      'GET /v1/payouts/po_st_missing payout_read|POST /v1/payouts payout_write');
  check1('rows: every row sends, every write plans its refusal', () =>
    rows.every((r) => r.expected.length > 0) && rows.filter((r) => r.kind === 'write').every((r) => (r.planned ?? []).length > 0));
  check1('rows: every request and expansion is mapped', () => m !== null && rows.filter((r) => r.kind !== 'control').every((r) => 'proves' in permissionsOf(r.expected, r.expand ?? [], m)));
  check1('rows: the rows that cannot report CODE prove every grant', () => {
    if (!m) return false;
    const proven = rows.filter((r) => r.kind !== 'control' && !r.codeOnExpand).map((r) => {
      const p = permissionsOf(r.expected, r.expand ?? [], m);
      return { kind: r.kind, verdict: 'PASS' as const, proves: 'proves' in p ? p.proves : [] };
    });
    return eq(coverage(m.granted, proven), []);
  });
  check1('rows: X2 alone may report CODE, and X2c proves invoice_read apart from it', () => {
    const x2c = rows.find((r) => r.id === 'X2c');
    return eq(rows.filter((r) => r.codeOnExpand).map((r) => r.id), ['X2']) && m !== null && x2c !== undefined && eq(permissionsOf(x2c.expected, [], m), { proves: ['invoice_read'] });
  });

  if (ran < SELF_TEST_MIN_CHECKS) fails.push(`only ${ran} check(s) ran (floor ${SELF_TEST_MIN_CHECKS})`);
  if (fails.length) {
    out(`✖ self-test FAILED (${fails.length} of ${ran}):`);
    fails.forEach((x) => out(`   - ${x}`));
    return 'FAIL';
  }
  out(`✓ self-test: ${ran} checks — masking, permission names, request matching, the manifest, every classification branch, the verdict, the rows.`);
  return 'PASS';
}

// ── the run ──────────────────────────────────────────────────────────────────

/** Everything the console prints while a row runs goes into that row, masked; between rows it goes to stderr, masked. */
function hookConsole(): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]): void => {
      const line = mask(args.map((a) => (a instanceof Error ? a.message : a !== null && typeof a === 'object' ? '[object]' : String(a))).join(' '));
      if (current) current.logs.push(line);
      else process.stderr.write(`${line}\n`);
    };
  }
}

/** The smoke's own output. Masked like everything else. */
const out = (line: string): void => {
  process.stdout.write(`${mask(line)}\n`);
};

const refuse = (why: string): Verdict => {
  out(`STRIPE_RAK_SMOKE_ERROR ${why}`);
  return 'INDETERMINATE';
};

const statusText = (seen: Seen[]): string => {
  const s = seen.map((x) => x.status);
  if (!s.length) return '-';
  return s.length > 2 && s.every((x) => x === s[0]) ? `${s[0]}x${s.length}` : s.join(',');
};

interface Ran {
  row: Row;
  proves: string[];
  outcome: Outcome;
  seen: Seen[];
  logs: string[];
}

function printRow(r: Ran): void {
  out(`  ${r.row.id} ${r.outcome.verdict} ${r.row.kind} ${statusText(r.seen)} ${r.outcome.why} · ${r.row.how}`);
  const ids = r.seen.map((s) => s.requestId).filter((x): x is string => Boolean(x));
  if (ids.length) out(`      ${ids.join(' ')}`);
  if (r.outcome.verdict !== 'PASS') for (const l of r.logs.slice(0, 3)) out(`      log: ${l}`);
}

/**
 * Runs the rows in order. The writes go only once every control was refused, and an accepted
 * control or write stops everything after it.
 */
async function runRows(rows: Row[], proves: Map<string, string[]>, ctx: Ctx): Promise<Ran[]> {
  const ran: Ran[] = [];
  let halt: string | null = null;
  for (const row of rows) {
    const controls = ran.filter((r) => r.row.kind === 'control');
    const refused = controls.length > 0 && controls.every((r) => r.outcome.verdict === 'PASS');
    const cap: Capture = { kind: row.kind, seen: [], errors: [], logs: [] };
    let done: Done;
    if (halt) done = { skipped: halt };
    else if (row.kind === 'write' && !refused) done = { skipped: 'not sent: a control was not refused, so no refusal can be read' };
    else {
      current = cap;
      try {
        done = await row.run(ctx);
      } catch (err) {
        cap.errors.push(refusalOf(err));
        done = {};
      }
      await new Promise((r) => setImmediate(r));
      current = null;
    }
    const outcome = classify({
      kind: row.kind, expected: row.expected, paged: row.paged ?? false, seen: cap.seen, errors: cap.errors, logs: cap.logs,
      permission: row.permission, codeOnExpand: row.codeOnExpand, planned: row.planned, ...done,
    });
    if (outcome.accepted) halt = `not run: ${row.id} was accepted`;
    const r: Ran = { row, proves: proves.get(row.id) ?? [], outcome, seen: cap.seen, logs: cap.logs };
    ran.push(r);
    printRow(r);
  }
  return ran;
}

/** The live check. Everything that can be refused before a request is sent is refused first. */
async function live(manifestPath: string): Promise<Verdict> {
  if (selfTest() !== 'PASS') return refuse('the self-test did not pass: nothing sent');
  let text: string;
  try {
    text = readFileSync(manifestPath === '-' ? 0 : manifestPath, 'utf8');
  } catch (err) {
    return refuse(`cannot read the manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  const man = parseManifest(text);
  if (typeof man === 'string') return refuse(`malformed manifest: ${man}`);
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const cls = keyClass(key);
  out(`STRIPE_RAK_SMOKE manifest=sha256:${man.sha16} key=${cls ? `${key.slice(0, 8)}…${key.slice(-4)}` : '(not shown)'}`);
  if (!cls) {
    return refuse(`not a restricted key: class ${/^(?:sk|rk|pk)_(?:live|test)_/.test(key) ? key.slice(0, 8) : key ? 'unrecognised' : 'none'}`);
  }
  const client = getStripeClient();
  if (!client) return refuse('the server built no Stripe client');

  const rows = rowsFor(man);
  const proves = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind === 'control') continue;
    const p = permissionsOf(row.expected, row.expand ?? [], man);
    if ('missing' in p) return refuse(`row ${row.id}: the manifest maps no permission for ${p.missing}`);
    proves.set(row.id, p.proves);
  }
  // A grant only a CODE-capable row could prove would leave AC3.2 to chance: refuse before sending.
  const unreachable = coverage(
    man.granted,
    rows.filter((r) => !r.codeOnExpand).map((r) => ({ kind: r.kind, verdict: 'PASS' as const, proves: proves.get(r.id) ?? [] })),
  );
  if (unreachable.length) return refuse(`no row can prove ${unreachable.join(', ')}: nothing sent`);

  hookConsole();
  client.on('response', (e: { method: string; path: string; status: number; request_id?: string }) => {
    current?.seen.push({ request: requestOf(e.method, e.path), status: e.status, requestId: e.request_id ?? null });
  });
  const ctx: Ctx = { client, found: {}, before: null, after: null };
  const ran = await runRows(rows, proves, ctx);

  const missing = coverage(man.granted, ran.map((r) => ({ kind: r.row.kind, verdict: r.outcome.verdict, proves: r.proves })));
  const code = ran.filter((r) => r.outcome.verdict === 'CODE').map((r) => r.row.id);
  const same = ctx.before && ctx.after ? (sameSet(ctx.before, ctx.after) ? 'yes' : 'no') : 'unknown';
  out(`STRIPE_RAK_SMOKE_COVERAGE granted=${man.granted.length} proven=${man.granted.length - missing.length} missing=${missing.join(',') || 'none'}`);
  out(`STRIPE_RAK_SMOKE_ENABLED_EVENTS before=${ctx.before?.length ?? '?'} after=${ctx.after?.length ?? '?'} same=${same}`);
  out(`STRIPE_RAK_SMOKE_CODE_ROWS=${code.join(',') || 'none'}`);
  out(`STRIPE_RAK_SMOKE_CODE_DEFECTS=${code.length}`);
  return overall(ran.map((r) => ({ verdict: r.outcome.verdict })), missing);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let verdict: Verdict;
  if (args.length === 1 && args[0] === '--self-test') verdict = selfTest();
  else if (args.length === 2 && args[0] === '--manifest') verdict = await live(args[1]);
  else verdict = refuse('usage: stripe-rak-smoke.js --manifest <path|-> | --self-test');
  out(`STRIPE_RAK_SMOKE_VERDICT=${verdict}`);
  return CODES[verdict];
}

if (require.main === module) {
  void runScript('stripe-rak-smoke', main, { watchdogMs: 300_000 });
}
