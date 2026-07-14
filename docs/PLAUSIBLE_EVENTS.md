# Plausible Custom Events — `algovault.com`

WEBSITE-REFRESH-W1 C6 ships the Plausible script tag (script ID `pa-RwGaS0xWrfzs4vNSkMOAX`, provided by architect mid-execution). Pageviews + bounce rate + outbound clicks track automatically. The 4 custom events below need **one-time configuration** in the **self-hosted** Plausible dashboard at <https://plausible.algovault.com/algovault.com/settings/goals> (~3 min total). _(Migrated off Plausible Cloud by SELFHOST-PLAUSIBLE-CE-AND-CF-ORIGIN-SHIELD-W1, 2026-07-12; script id is now `pa-gfOGxVcQKNfocPr5V3vR8` on `plausible.algovault.com`.)_

## Convention

All custom events are tracked via `window.plausible('<Event Name>', { props: { ... } })` calls embedded in the HTML pages. The Plausible dashboard surfaces these as **Goals** once configured.

## 4 events to configure

### 1. `Signup Click`

**Where it fires:** Click on any "Sign Up" or "Subscribe" CTA targeting `api.algovault.com/signup?plan=*`.

**Suggested data attributes (add to the relevant CTA tags):**

```html
<a href="https://api.algovault.com/signup?plan=starter"
   class="..."
   onclick="plausible('Signup Click', { props: { plan: 'starter', source: 'pricing-section' } })">
  Subscribe to Starter
</a>
```

**Plausible dashboard config:** Settings → Goals → New Goal → **Custom event** → Event name: `Signup Click`.

### 2. `Plan Selection`

**Where it fires:** When a visitor changes the highlighted/selected pricing card OR clicks any per-tier "Subscribe to X" button (independent from `Signup Click` so we can attribute "looked at the tier" vs "clicked the CTA").

**Suggested:** Lower-friction event — fired on any pricing-card hover-then-click pattern. For now, pair with the same `onclick` as `Signup Click` but track **only the plan name**:

```html
onclick="plausible('Plan Selection', { props: { plan: 'starter' } })"
```

**Plausible dashboard config:** Goals → New Goal → Custom event → `Plan Selection`.

### 3. `Skill Install Click`

**Where it fires:** Click on the per-card "View Skill →" CTA on `/docs.html` (×20) and on the per-card CTA on `/skills` (×20).

**Suggested data attributes:**

```html
<a href="https://github.com/AlgoVaultLabs/algovault-skills/tree/main/skills/<slug>?utm_source=docs&utm_medium=card&utm_campaign=skill-install-<slug>"
   onclick="plausible('Skill Install Click', { props: { slug: '<slug>', surface: 'docs' } })">
  View Skill →
</a>
```

For the `/skills` page CTAs, use `surface: 'skills_page'`.

**Plausible dashboard config:** Goals → New Goal → Custom event → `Skill Install Click`.

### 4. `Integration View`

**Where it fires:** Click on any of the 4 Use Cases cards on `/` (Binance/OKX/Bybit/Bitget) OR direct visit to any `/integrations/*` mirror.

**Suggested data attributes:**

```html
<a href="/integrations/binance?utm_source=index&utm_medium=use-cases-card&utm_campaign=integration-binance"
   onclick="plausible('Integration View', { props: { exchange: 'binance', source: 'use-cases-card' } })">
  ...
</a>
```

For direct visits to the mirror pages: add a `<script>plausible('Integration View', { props: { exchange: '<exchange>', source: 'direct' } });</script>` at the bottom of each mirror's `<body>` (one line per mirror; see `landing/integrations/*.html`).

**Plausible dashboard config:** Goals → New Goal → Custom event → `Integration View`.

## Optional: GEO-referrer goals (set up post-C7)

C7 adds 2 more goals for AI-referred traffic — see `docs/PLAUSIBLE_GEO_GOALS.md` for those (separate from these 4 conversion-funnel goals).

## Verification

After configuration, test each event by:

1. Opening the Plausible dashboard live view (<https://plausible.algovault.com/algovault.com>).
2. Triggering the relevant CTA in a browser tab.
3. Confirming the event appears in the live event stream within 10 seconds.

If the event doesn't appear: check that the page loads the Plausible script (DevTools → Network → filter `plausible.io`), confirm the dashboard shows pageviews, then re-test the custom-event call (`window.plausible.q` should not be `undefined`).
