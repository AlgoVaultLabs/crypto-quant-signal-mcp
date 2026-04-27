# Exchange logos — provenance + license basis

Used on `algovault.com` for nominative reference to integration tutorials in `landing/index.html` (Use Cases section) and `landing/integrations.html` (index page). Per WEBSITE-REFRESH-W1 cleanup R5, these replaced emoji placeholders for a more professional appearance.

## Files

| File | Size | Type | Source URL | Downloaded | License basis |
|---|---|---|---|---|---|
| `binance.svg` | 3.9 KB | SVG, viewBox `0 0 632.014 126.611` (wordmark) | https://commons.wikimedia.org/wiki/Special:FilePath/Binance_logo.svg | 2026-04-27 | Wikimedia Commons (per Commons file page: Binance corporate logo, used under nominative-fair-use; trademark of Binance Holdings Ltd.) |
| `okx.svg` | 3.5 KB | SVG, viewBox `0 0 1080 1080` (icon) | https://commons.wikimedia.org/wiki/Special:FilePath/OKX_Logo.svg | 2026-04-27 | Wikimedia Commons (OKX corporate logo, nominative-fair-use; trademark of OKX/Aux Cayes FinTech Co. Ltd.) |
| `bybit.svg` | 1.9 KB | SVG, viewBox `0 0 13547 4513` (wordmark with orange "I" bar) | https://commons.wikimedia.org/wiki/Special:FilePath/Bybit_Logo.svg | 2026-04-27 | Wikimedia Commons (Bybit corporate logo, nominative-fair-use; trademark of Bybit Fintech Ltd.) |
| `bitget.png` | 5.0 KB | PNG, 420×420 px (icon) | https://avatars.githubusercontent.com/u/95041826?s=200 | 2026-04-27 | BitgetLimited's OFFICIAL GitHub organization avatar (org URL: https://github.com/BitgetLimited; same org that publishes `bitget-mcp-server` npm). Direct from Bitget. Wikimedia Commons SVG variants returned 404 at probe time; bitget.com/media-kit page timed out on direct fetch. PNG is official + correctly-sized fallback. |

## Usage policy

- **Nominative fair use only.** Logos are used to identify the integration tutorial (e.g., "Binance × AlgoVault"), NOT to imply partnership, sponsorship, or endorsement.
- **No modification.** Logos are used as-downloaded. We do not recolor (except via CSS `filter: invert()` for monochrome assets to match the dark navy theme — this is a CSS rendering tweak, not a modification of the source asset).
- **Trademark notice rendered alongside.** Both `landing/index.html` Use Cases section and `landing/integrations.html` carry a footer disclaimer: *"Exchange logos and names are trademarks of their respective owners. Used for nominative reference to integration tutorials. No partnership or endorsement implied."*
- **Replace if unauthorized.** If any logo's owner objects to its use, replace with a textual treatment (`<span class="font-mono">BINANCE</span>` style wordmark in their brand color) or remove entirely.

## CSS rendering

| File | Rendering class | Notes |
|---|---|---|
| `binance.svg` | `w-10 h-10 object-contain` | Yellow-on-black wordmark; visible on dark theme without inversion. |
| `okx.svg` | `w-10 h-10 object-contain invert` | Black icon on white background — `invert` recolors to white-on-(transparent over navy). |
| `bybit.svg` | `w-10 h-10 object-contain invert` | Mostly-black wordmark — `invert` makes it visible on dark theme. |
| `bitget.png` | `w-10 h-10 object-contain` | Color icon; visible without modification. |

## Refresh procedure

If a logo becomes outdated (rebrand) or if you want to re-source from official press kits:
1. Visit the exchange's official press/media-kit URL (Binance: `binance.com/en-GB/press`; OKX: `okx.com/about/press`; Bybit: `bybit.com/en/press`; Bitget: `bitget.com/media-kit`).
2. Download the primary monochrome OR primary color variant.
3. Replace the corresponding file in this directory.
4. Update this README's table row with the new source URL, dimensions, and download date.
5. Re-test rendering on the dark theme; adjust the CSS class if needed (add/remove `invert`).

If an official press-kit URL is unreachable: fall back to Wikimedia Commons (`commons.wikimedia.org/wiki/Special:FilePath/<Exchange>_Logo.svg`) — vetted re-uploads of corporate logos with stable URLs and CC-licensed file pages.
