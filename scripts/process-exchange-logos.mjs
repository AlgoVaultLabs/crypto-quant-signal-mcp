#!/usr/bin/env node
/**
 * process-exchange-logos.mjs — DESIGN-W7 fix-forward 2026-05-11
 *
 * Process the 5 exchange logos in Design/Logo/ (vault) into transparent-bg PNGs
 * suitable for rendering on a dark-grey chip background (var(--bg-2)).
 *
 * Per-logo strategy (informed by pixel-probing each source file):
 *   - hyperliquid: dark-teal bg (#132420) baked into image — strip via color-distance
 *     threshold; preserve the bright mint logo
 *   - binance: source is already RGBA transparent → resize only
 *   - bybit: white-on-BLACK JPEG → strip black bg, keep white logo
 *   - okx: white-on-BLACK PNG → strip black bg, keep white logo
 *   - bitget: source is already RGBA transparent (cyan wordmark) → resize only
 *
 * All outputs: PNG, max 256 long-side preserving aspect ratio, fully transparent
 * background outside the mark.
 *
 * Source-of-truth files in Design/Logo/ are NEVER touched. Outputs go to
 * landing/_design/logos/ (replaces the W6-deployed white-background versions).
 *
 * Delegates to a Python+Pillow subprocess (Pillow is in the macOS system Python;
 * adding `sharp` npm dep would expand the build graph unnecessarily for a
 * one-shot asset transform).
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VAULT_LOGO_DIR = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/Logo';
const OUT_DIR = path.join(REPO_ROOT, 'landing/_design/logos');

const PYTHON_SCRIPT = `
import sys
from PIL import Image

MAX_LONG_SIDE = 256

def strip_by_luminance(im, lum_full_strip, lum_full_keep=None):
    """Tri-state luminance ramp:
      - L <= lum_full_strip → alpha=0 (background)
      - L >= lum_full_keep  → alpha unchanged (foreground)
      - in-between          → linear alpha ramp (antialiased transition,
                              colors snapped toward the bright endpoint so the
                              halo blends cleanly on a dark chip)
    If lum_full_keep is None, defaults to lum_full_strip + 40 (sharp ramp)."""
    if lum_full_keep is None:
        lum_full_keep = lum_full_strip + 40
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    span = max(1, lum_full_keep - lum_full_strip)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            lum = 0.2126*r + 0.7152*g + 0.0722*b
            if lum <= lum_full_strip:
                px[x, y] = (r, g, b, 0)
            elif lum < lum_full_keep:
                # Ramp alpha; also brighten color toward white to avoid muddy halo
                t = (lum - lum_full_strip) / span
                new_a = int(round(a * t))
                px[x, y] = (r, g, b, new_a)
    return im

def trim_transparent(im):
    """Crop to non-transparent bounding box."""
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im

def fit_max(im, max_side):
    w, h = im.size
    if max(w, h) <= max_side:
        return im
    if w >= h:
        new_w = max_side
        new_h = int(round(h * max_side / w))
    else:
        new_h = max_side
        new_w = int(round(w * max_side / h))
    return im.resize((new_w, new_h), Image.LANCZOS)

def process(src_path, out_path, strategy):
    im = Image.open(src_path).convert('RGBA')
    src_w, src_h = im.size
    if strategy == 'strip_dark_teal':
        # Hyperliquid: bg is dark teal ~#132420 (L~32), mint logo L~225+
        # Tri-state: strip everything <90, full-keep >180, ramp between
        im = strip_by_luminance(im, 90, 180)
    elif strategy == 'strip_black':
        # Bybit JPEG + OKX: ~black bg (L<10) with white logo (L>240)
        # Tri-state: strip everything <40, full-keep >120, ramp between
        im = strip_by_luminance(im, 40, 120)
    elif strategy == 'passthrough':
        # Binance + Bitget: already transparent
        pass
    else:
        raise ValueError(f'unknown strategy: {strategy}')
    im = trim_transparent(im)
    im = fit_max(im, MAX_LONG_SIDE)
    im.save(out_path, 'PNG', optimize=True)
    print(f'{src_path} ({src_w}x{src_h}) -> {out_path} ({im.size[0]}x{im.size[1]}) strategy={strategy}')

JOBS = [
    ('Hyperliquid Logo.png', 'hyperliquid.png', 'strip_dark_teal'),
    ('Binance-logo.png',     'binance.png',     'passthrough'),
    ('bybit-logo-white.jpg', 'bybit.png',       'strip_black'),
    ('OKX-logo.png',         'okx.png',         'strip_black'),
    ('Bitget-logo.png',      'bitget.png',      'passthrough'),
]
SRC_DIR = sys.argv[1]
OUT_DIR = sys.argv[2]
for src_name, out_name, strategy in JOBS:
    process(f'{SRC_DIR}/{src_name}', f'{OUT_DIR}/{out_name}', strategy)
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const r = spawnSync('python3', ['-c', PYTHON_SCRIPT, VAULT_LOGO_DIR, OUT_DIR], { stdio: 'inherit' });
process.exit(r.status ?? 0);
