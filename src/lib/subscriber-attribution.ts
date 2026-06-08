/**
 * SUBSCRIBER-ATTRIBUTION-SPINE-W1 — durable acquisition-attribution spine.
 *
 * The reusable, channel-agnostic artifact: capture (C1), conversion-time
 * profiler (C2), admin read (C3). New producers (TG bot / MCP upgrade / raw
 * API) plug in by emitting a `<channel>:<ts>:<rand>` client_reference_id at
 * click time — no schema change.
 *
 * Privacy: stores ip_hash (sha256→16hex via analytics.hashIp), NEVER a raw IP.
 * PII (name/email/country) lives ONLY in subscriber_profiles (C2) behind the
 * ADMIN_API_KEY-gated route (C3); it never touches the MCP surface or any
 * public/un-gated route.
 *
 * Fail-open is LAW for this wave: capture/profiler are fire-and-forget +
 * try-caught so a DB error can never block, slow, or fail the /signup redirect,
 * the payment, or the entitlement grant.
 */
import { dbExec, dbRun, dbQuery } from './performance-db.js';

const PG = !!process.env.DATABASE_URL;
const TS = PG ? 'TIMESTAMPTZ' : 'TIMESTAMP';
const NOW = PG ? 'now()' : "(datetime('now'))";

// ── C1: signup attribution capture ──────────────────────────────────────────

const CREATE_SIGNUP_ATTRIBUTION_SQL = `
  CREATE TABLE IF NOT EXISTS signup_attribution (
    client_reference_id TEXT PRIMARY KEY,
    created_at ${TS} NOT NULL DEFAULT ${NOW},
    channel TEXT NOT NULL DEFAULT 'unknown',
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    referrer TEXT,
    landing_path TEXT,
    tier_requested TEXT,
    ip_hash TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_signup_attribution_created_at ON signup_attribution (created_at);
`;

let _signupAttributionInit = false;
export function ensureSignupAttributionSchema(): void {
  if (_signupAttributionInit) return;
  dbExec(CREATE_SIGNUP_ATTRIBUTION_SQL);
  _signupAttributionInit = true;
}

/**
 * Channel-agnostic derivation from the synthetic client_reference_id prefix
 * (`<channel>:<ts>:<rand>`), with a utm_source fallback. Pure + unit-tested so
 * future producers (TG / MCP / API) are a one-line prefix, no schema change.
 */
export function deriveChannel(clientRefId: string, utmSource?: string | null): string {
  const id = (clientRefId || '').toLowerCase();
  if (id.startsWith('tg_bot:') || id.startsWith('tg:')) return 'tg_bot';
  if (id.startsWith('mcp:')) return 'mcp';
  if (id.startsWith('api:')) return 'api';
  if (id.startsWith('direct:')) return 'direct';
  const u = (utmSource || '').toLowerCase();
  if (u) {
    if (u.includes('telegram') || u.includes('tg')) return 'tg_bot';
    if (u.includes('mcp')) return 'mcp';
    if (u.includes('api')) return 'api';
  }
  return 'unknown';
}

export interface SignupAttributionInput {
  clientReferenceId: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  tierRequested?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
}

/** DI seam — tests inject a throwing/recording writer to prove fail-open. */
export interface AttributionWriter {
  ensure: () => void;
  run: (sql: string, ...params: unknown[]) => void;
}
const defaultWriter: AttributionWriter = { ensure: ensureSignupAttributionSchema, run: dbRun };

/**
 * Fail-open, fire-and-forget capture of a /signup click. `ON CONFLICT
 * (client_reference_id) DO NOTHING` makes a re-click idempotent. NEVER throws —
 * any capture error is swallowed + logged so the 303 redirect is byte- and
 * latency-unaffected (revenue path is LAW for this wave).
 */
export function recordSignupAttribution(
  input: SignupAttributionInput,
  writer: AttributionWriter = defaultWriter,
): void {
  try {
    writer.ensure();
    const channel = deriveChannel(input.clientReferenceId, input.utmSource ?? null);
    writer.run(
      `INSERT INTO signup_attribution
        (client_reference_id, channel, utm_source, utm_medium, utm_campaign, referrer, landing_path, tier_requested, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_reference_id) DO NOTHING`,
      input.clientReferenceId,
      channel,
      input.utmSource ?? null,
      input.utmMedium ?? null,
      input.utmCampaign ?? null,
      input.referrer ?? null,
      input.landingPath ?? null,
      input.tierRequested ?? null,
      input.ipHash ?? null,
      input.userAgent ?? null,
    );
  } catch (err) {
    console.warn('[recordSignupAttribution] capture failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

// ── C2: conversion-time auto-profiler (the productized diagnosis) ────────────

const CREATE_SUBSCRIBER_PROFILES_SQL = `
  CREATE TABLE IF NOT EXISTS subscriber_profiles (
    customer_id TEXT PRIMARY KEY,
    created_at ${TS} DEFAULT ${NOW},
    email TEXT,
    name TEXT,
    subscription_id TEXT,
    tier TEXT,
    status TEXT,
    amount_usd ${PG ? 'NUMERIC(10,2)' : 'REAL'},
    currency TEXT,
    channel TEXT,
    country TEXT,
    country_source TEXT,
    client_reference_id TEXT,
    signup_at ${TS},
    converted_at ${TS},
    latency_seconds INTEGER,
    cold_subscribe BOOLEAN,
    attribution_captured BOOLEAN,
    risk_level TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subscriber_profiles_converted_at ON subscriber_profiles (converted_at DESC);
`;

let _subscriberProfilesInit = false;
export function ensureSubscriberProfilesSchema(): void {
  if (_subscriberProfilesInit) return;
  dbExec(CREATE_SUBSCRIBER_PROFILES_SQL);
  _subscriberProfilesInit = true;
}

export interface SubscriberProfile {
  customerId: string;
  email: string | null;
  name: string | null;
  subscriptionId: string | null;
  tier: string | null;
  status: string | null;
  amountUsd: number | null;
  currency: string | null;
  channel: string;
  country: string | null;
  countrySource: string | null;
  clientReferenceId: string | null;
  signupAt: string | null;
  convertedAt: string;
  latencySeconds: number | null;
  coldSubscribe: boolean | null;
  attributionCaptured: boolean;
  riskLevel: string | null;
}

export interface ProfileSignals {
  attribution?: { channel: string; created_at: string } | null;
  hasOptin?: boolean;
  hasUpgradeCta?: boolean;
  /** Geo tier-1 (card-issuing / Link country) when resolvable; else billing-address is used. */
  cardCountry?: string | null;
  riskLevel?: string | null;
  /** Conversion epoch (sec) — injected so assembleProfile stays pure/testable. */
  convertedAtEpoch: number;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pure assembly of a subscriber profile from the Stripe checkout session +
 * resolved first-party signals. No I/O, no Date.now (convertedAtEpoch injected)
 * — so channel-resolution order / geo source / cold logic / latency are unit-
 * testable. NEVER fabricates an IP or geo: country comes ONLY from the supplied
 * cardCountry (tier-1) or the session's billing-address country (tier-2).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assembleProfile(session: any, signals: ProfileSignals): SubscriberProfile {
  const customerId = typeof session?.customer === 'string'
    ? session.customer
    : asString(session?.customer?.id) ?? '';
  const cd = session?.customer_details ?? {};
  const email = asString(cd.email) ?? asString(session?.customer_email);
  const clientReferenceId = asString(session?.client_reference_id);
  const utmSource = asString(session?.metadata?.utm_source);

  // Channel: (1) the joined signup_attribution channel; (2) deriveChannel
  // fallback; (3) 'unknown'. attribution_captured records whether a click row
  // existed (the pre-spine cohort, e.g. cus_UepU…, has none → false).
  const attributionCaptured = !!signals.attribution;
  const channel = signals.attribution?.channel
    ?? deriveChannel(clientReferenceId ?? '', utmSource);

  // Geo: card-issuing (tier-1, when resolvable) → billing-address country.
  // Never an IP. country_source names the field used.
  const billingCountry = asString(cd.address?.country);
  let country: string | null = null;
  let countrySource: string | null = null;
  if (signals.cardCountry) { country = signals.cardCountry; countrySource = 'card_issuing'; }
  else if (billingCountry) { country = billingCountry; countrySource = 'billing_address'; }

  // Latency: signup→convert from the attribution row when present, else the
  // session create→complete delta. Clamp ≥ 0 (clock-skew safety).
  const signupAt = asString(signals.attribution?.created_at);
  let latencySeconds: number | null = null;
  if (signupAt) {
    const s = Math.floor(new Date(signupAt).getTime() / 1000);
    if (Number.isFinite(s)) latencySeconds = Math.max(0, signals.convertedAtEpoch - s);
  } else if (typeof session?.created === 'number') {
    latencySeconds = Math.max(0, signals.convertedAtEpoch - session.created);
  }

  // cold_subscribe = email present AND no free-tier opt-in AND no upgrade-CTA
  // bridge. Honest NULL when email is absent (indeterminable).
  const coldSubscribe = email ? (!signals.hasOptin && !signals.hasUpgradeCta) : null;

  const amountTotal = typeof session?.amount_total === 'number' ? session.amount_total : null;

  return {
    customerId,
    email,
    name: asString(cd.name),
    subscriptionId: typeof session?.subscription === 'string'
      ? session.subscription
      : asString(session?.subscription?.id),
    tier: asString(session?.metadata?.tier),
    status: 'active', // checkout.session.completed ⇒ the subscription is live
    amountUsd: amountTotal != null ? Math.round(amountTotal) / 100 : null,
    currency: asString(session?.currency),
    channel,
    country,
    countrySource,
    clientReferenceId,
    signupAt,
    convertedAt: new Date(signals.convertedAtEpoch * 1000).toISOString(),
    latencySeconds,
    coldSubscribe,
    attributionCaptured,
    riskLevel: signals.riskLevel ?? null,
  };
}

export interface ProfileDeps {
  ensure: () => void;
  query: <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;
  run: (sql: string, ...params: unknown[]) => void;
  /** Optional best-effort tier-1 geo + risk (card-issuing / Link country). */
  resolveCardGeo?: (customerId: string) => Promise<{ country: string | null; riskLevel: string | null } | null>;
  /** Conversion epoch override (sec) — for deterministic tests/backfill. */
  nowEpoch?: number;
}
const defaultProfileDeps: ProfileDeps = {
  ensure: () => { ensureSubscriberProfilesSchema(); ensureSignupAttributionSchema(); },
  query: dbQuery,
  run: dbRun,
};

/**
 * Conversion-time auto-profiler — the productized SUBSCRIBER-ATTRIBUTION-
 * DIAGNOSIS-W1. Called from the checkout.session.completed case AFTER
 * tryClaimEvent (so a webhook replay never re-profiles), and ALSO idempotent on
 * subscriber_profiles.customer_id (ON CONFLICT DO UPDATE). Fail-open: any error
 * is swallowed + logged so the webhook still 200s and the entitlement grant is
 * never affected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildSubscriberProfile(session: any, deps: ProfileDeps = defaultProfileDeps): Promise<void> {
  try {
    const customerId = typeof session?.customer === 'string'
      ? session.customer
      : asString(session?.customer?.id);
    if (!customerId) {
      console.warn('[buildSubscriberProfile] no customer id on session — skipping (fail-open)');
      return;
    }
    deps.ensure();

    const clientReferenceId = asString(session?.client_reference_id);
    const email = asString(session?.customer_details?.email) ?? asString(session?.customer_email);

    // (1) channel via JOIN signup_attribution by client_reference_id
    let attribution: { channel: string; created_at: string } | null = null;
    if (clientReferenceId) {
      const rows = await deps.query<{ channel: string; created_at: unknown }>(
        'SELECT channel, created_at FROM signup_attribution WHERE client_reference_id = ?',
        [clientReferenceId],
      );
      if (rows.length > 0) attribution = { channel: String(rows[0].channel), created_at: String(rows[0].created_at) };
    }
    // (2) cold-subscribe signals: free-tier opt-in + upgrade-CTA bridge
    let hasOptin = false;
    let hasUpgradeCta = false;
    if (email) {
      const optin = await deps.query('SELECT 1 AS one FROM signup_emails WHERE lower(email) = lower(?) LIMIT 1', [email]);
      hasOptin = optin.length > 0;
    }
    if (clientReferenceId) {
      const cta = await deps.query(
        "SELECT 1 AS one FROM funnel_events WHERE event_type = 'upgrade_cta_clicked' AND session_id = ? LIMIT 1",
        [clientReferenceId],
      );
      hasUpgradeCta = cta.length > 0;
    }
    // (3) optional tier-1 geo + risk (best-effort; never blocks/throws)
    let cardCountry: string | null = null;
    let riskLevel: string | null = null;
    if (deps.resolveCardGeo) {
      try {
        const g = await deps.resolveCardGeo(customerId);
        cardCountry = g?.country ?? null;
        riskLevel = g?.riskLevel ?? null;
      } catch (e) {
        console.warn('[buildSubscriberProfile] card-geo enrich failed (fall back to billing):', e instanceof Error ? e.message : e);
      }
    }

    const nowEpoch = deps.nowEpoch ?? Math.floor(Date.now() / 1000);
    const p = assembleProfile(session, { attribution, hasOptin, hasUpgradeCta, cardCountry, riskLevel, convertedAtEpoch: nowEpoch });

    deps.run(
      `INSERT INTO subscriber_profiles
        (customer_id, email, name, subscription_id, tier, status, amount_usd, currency, channel, country, country_source,
         client_reference_id, signup_at, converted_at, latency_seconds, cold_subscribe, attribution_captured, risk_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (customer_id) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, subscription_id = EXCLUDED.subscription_id,
         tier = EXCLUDED.tier, status = EXCLUDED.status, amount_usd = EXCLUDED.amount_usd, currency = EXCLUDED.currency,
         channel = EXCLUDED.channel, country = EXCLUDED.country, country_source = EXCLUDED.country_source,
         client_reference_id = EXCLUDED.client_reference_id, signup_at = EXCLUDED.signup_at,
         converted_at = EXCLUDED.converted_at, latency_seconds = EXCLUDED.latency_seconds,
         cold_subscribe = EXCLUDED.cold_subscribe, attribution_captured = EXCLUDED.attribution_captured,
         risk_level = EXCLUDED.risk_level`,
      p.customerId, p.email, p.name, p.subscriptionId, p.tier, p.status, p.amountUsd, p.currency, p.channel,
      p.country, p.countrySource, p.clientReferenceId, p.signupAt, p.convertedAt, p.latencySeconds,
      p.coldSubscribe, p.attributionCaptured, p.riskLevel,
    );
    console.log(`[buildSubscriberProfile] profiled ${p.customerId} channel=${p.channel} country=${p.country ?? '?'}/${p.countrySource ?? '-'} cold=${p.coldSubscribe} captured=${p.attributionCaptured}`);
  } catch (err) {
    console.error('[buildSubscriberProfile] failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

// ── C3: operator admin tracker (read + aggregate + PII-free shell) ───────────

export interface SubscriberProfileRow {
  customer_id: string;
  email: string | null;
  name: string | null;
  subscription_id: string | null;
  tier: string | null;
  status: string | null;
  amount_usd: number | null;
  currency: string | null;
  channel: string | null;
  country: string | null;
  country_source: string | null;
  client_reference_id: string | null;
  signup_at: string | null;
  converted_at: string | null;
  latency_seconds: number | null;
  cold_subscribe: boolean | null;
  attribution_captured: boolean | null;
  risk_level: string | null;
  created_at?: string | null;
}

/** Admin read — newest conversions first. Clamped limit/offset (integers only). */
export async function listSubscriberProfiles(opts: { limit?: number; offset?: number } = {}): Promise<SubscriberProfileRow[]> {
  ensureSubscriberProfilesSchema();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  return dbQuery<SubscriberProfileRow>(
    `SELECT customer_id, email, name, subscription_id, tier, status, amount_usd, currency, channel,
            country, country_source, client_reference_id, signup_at, converted_at, latency_seconds,
            cold_subscribe, attribution_captured, risk_level, created_at
     FROM subscriber_profiles
     ORDER BY converted_at DESC NULLS LAST, created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [],
  );
}

export interface ProfileAggregates {
  total: number;
  byChannel: Record<string, number>;
  byCountry: Record<string, number>;
  cold: number;
  warm: number;
  coldUnknown: number;
}

/** Pure aggregate for the admin header cards (counts by channel / country / cold-warm). */
export function aggregateProfiles(
  rows: Array<{ channel?: string | null; country?: string | null; cold_subscribe?: boolean | null }>,
): ProfileAggregates {
  const byChannel: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  let cold = 0, warm = 0, coldUnknown = 0;
  for (const r of rows) {
    const ch = r.channel || 'unknown';
    byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    const co = r.country || 'unknown';
    byCountry[co] = (byCountry[co] ?? 0) + 1;
    if (r.cold_subscribe === true) cold++;
    else if (r.cold_subscribe === false) warm++;
    else coldUnknown++;
  }
  return { total: rows.length, byChannel, byCountry, cold, warm, coldUnknown };
}

/**
 * Static operator shell for GET /admin/subscribers. Carries ZERO PII: the admin
 * key is prompted client-side, kept in sessionStorage (NEVER the URL or a server
 * log), and sent ONLY as a Bearer header on the XHR to the gated
 * /api/admin/subscribers. PII flows exclusively through that authed XHR, never
 * the server-rendered HTML. (No backticks / ${} inside the embedded JS — avoids
 * template-literal collision per CLAUDE.md.)
 */
export function renderSubscribersAdminHtml(): string {
  const css = [
    ':root{color-scheme:dark}*{box-sizing:border-box}',
    'body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#e6edf3}',
    'header{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid #1c2430;background:#0e141b}',
    'h1{font-size:18px;margin:0}.sub{color:#7d8590;font-size:12px}',
    'header button{margin-left:auto;background:#1c2430;color:#e6edf3;border:1px solid #2d3748;border-radius:6px;padding:6px 12px;cursor:pointer}',
    'header button+button{margin-left:8px}',
    '#auth{max-width:520px;margin:48px auto;padding:24px;background:#0e141b;border:1px solid #1c2430;border-radius:10px}',
    '#auth p{color:#9aa5b1}#key{width:100%;padding:10px;margin:8px 0;background:#0b0f14;border:1px solid #2d3748;border-radius:6px;color:#e6edf3}',
    '#load,#auth button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer;font-weight:600}',
    '.err{color:#f87171;min-height:18px}',
    '.cards{display:flex;flex-wrap:wrap;gap:12px;padding:20px 24px}',
    '.card{background:#0e141b;border:1px solid #1c2430;border-radius:10px;padding:14px 18px;min-width:150px}',
    '.card .n{font-size:24px;font-weight:700}.card .l{color:#7d8590;font-size:12px;text-transform:uppercase;letter-spacing:.04em}',
    '.card .b{color:#9aa5b1;font-size:12px;margin-top:4px}',
    'table{width:calc(100% - 48px);margin:0 24px 40px;border-collapse:collapse;background:#0e141b;border:1px solid #1c2430;border-radius:10px;overflow:hidden}',
    'th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #161d27;font-variant-numeric:tabular-nums}',
    'th{background:#111823;color:#7d8590;font-size:12px;text-transform:uppercase;letter-spacing:.04em}',
    'tbody tr:hover{background:#111823}.cold{color:#60a5fa}.warm{color:#fbbf24}.muted{color:#7d8590}',
  ].join('');

  // Embedded client JS — string-concat only (no backticks, no ${}).
  const js = [
    "(function(){",
    "var KN='av_admin_key';",
    "function $(id){return document.getElementById(id);}",
    "function esc(s){if(s==null)return '';return String(s).replace(/[&<>\"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
    "function gk(){try{return sessionStorage.getItem(KN)||'';}catch(e){return '';}}",
    "function sk(k){try{sessionStorage.setItem(KN,k);}catch(e){}}",
    "function ck(){try{sessionStorage.removeItem(KN);}catch(e){}}",
    "function showAuth(msg){$('auth').style.display='block';$('tbl').hidden=true;$('cards').innerHTML='';$('refresh').hidden=true;$('logout').hidden=true;$('err').textContent=msg||'';}",
    "function dur(s){if(s==null)return '-';s=Number(s);if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}",
    "function money(a,c){if(a==null)return '-';return '$'+Number(a).toFixed(2)+(c&&c!=='usd'?(' '+String(c).toUpperCase()):'');}",
    "function coldCell(v){if(v===true)return '<span class=cold>cold</span>';if(v===false)return '<span class=warm>warm</span>';return '<span class=muted>?</span>';}",
    "function kv(o){var out='';for(var k in o){out+=esc(k)+' '+o[k]+'  ';}return out||'-';}",
    "function render(d){",
    "  var a=d.aggregates||{};",
    "  $('cards').innerHTML=",
    "    card(d.count||0,'Subscribers','')+",
    "    card(a.cold||0,'Cold',(a.warm||0)+' warm / '+(a.coldUnknown||0)+' n-a')+",
    "    card(Object.keys(a.byChannel||{}).length,'Channels',kv(a.byChannel||{}))+",
    "    card(Object.keys(a.byCountry||{}).length,'Countries',kv(a.byCountry||{}));",
    "  var tb=$('tbl').querySelector('tbody');tb.innerHTML='';",
    "  (d.subscribers||[]).forEach(function(s){",
    "    var tr=document.createElement('tr');",
    "    tr.innerHTML='<td>'+esc(s.name)+'</td><td>'+esc(s.email)+'</td><td>'+esc(s.channel)+'</td>'+",
    "      '<td>'+esc(s.country)+'</td><td>'+esc(s.tier)+'</td><td>'+esc(s.status)+'</td>'+",
    "      '<td>'+money(s.amount_usd,s.currency)+'</td><td>'+dur(s.latency_seconds)+'</td>'+",
    "      '<td>'+coldCell(s.cold_subscribe)+'</td><td class=muted>'+esc(s.converted_at)+'</td>';",
    "    tb.appendChild(tr);",
    "  });",
    "  $('auth').style.display='none';$('tbl').hidden=false;$('refresh').hidden=false;$('logout').hidden=false;",
    "}",
    "function card(n,l,b){return '<div class=card><div class=n>'+esc(n)+'</div><div class=l>'+esc(l)+'</div><div class=b>'+esc(b)+'</div></div>';}",
    "function load(){",
    "  var key=gk();if(!key){showAuth();return;}",
    "  fetch('/api/admin/subscribers',{headers:{'Authorization':'Bearer '+key},cache:'no-store'})",
    "   .then(function(r){if(r.status===401){ck();showAuth('Invalid or missing key.');throw new Error('401');}return r.json();})",
    "   .then(render).catch(function(e){if(String(e.message)!=='401')showAuth('Load failed: '+esc(e.message));});",
    "}",
    "$('load').addEventListener('click',function(){var k=$('key').value.trim();if(!k){$('err').textContent='Enter a key.';return;}sk(k);$('key').value='';load();});",
    "$('refresh').addEventListener('click',load);",
    "$('logout').addEventListener('click',function(){ck();showAuth('Key forgotten.');});",
    "if(gk())load();else showAuth();",
    "})();",
  ].join('\n');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>AlgoVault — Subscriber Tracker (admin)</title>'
    + '<style>' + css + '</style></head><body>'
    + '<header><h1>Subscriber Tracker</h1><span class="sub">attribution spine · operator-only</span>'
    + '<button id="refresh" hidden>Refresh</button><button id="logout" hidden>Forget key</button></header>'
    + '<div id="auth"><p>Paste the admin API key to load subscribers. The key is kept in this tab only '
    + '(sessionStorage) and sent as a Bearer header — never placed in the URL or a server log.</p>'
    + '<input id="key" type="password" placeholder="ADMIN_API_KEY" autocomplete="off">'
    + '<button id="load">Load</button><p id="err" class="err"></p></div>'
    + '<div id="cards" class="cards"></div>'
    + '<table id="tbl" hidden><thead><tr>'
    + '<th>Name</th><th>Email</th><th>Channel</th><th>Country</th><th>Tier</th><th>Status</th>'
    + '<th>$</th><th>Latency</th><th>Cold/Warm</th><th>Converted</th>'
    + '</tr></thead><tbody></tbody></table>'
    + '<script>' + js + '</script></body></html>';
}
