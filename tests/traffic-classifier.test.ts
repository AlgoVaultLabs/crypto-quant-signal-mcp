/**
 * OPS-ACTIVATION-LEAK-FIX-W1 CH3 — unit tests for the canonical traffic
 * classifier. Pure (no DB/network). Covers the AC matrix (known bots / agents /
 * browser / health-checks), the isbot false-positive un-tag (claude-code,
 * Cursor), the L4 datacenter-combining path, and the single-derivation subset
 * canary `is_bot_internal===true ⟹ automated`.
 */
import { describe, expect, it } from 'vitest';
import { classifyTraffic, _defaultIsDatacenterIpForTest } from '../src/lib/traffic-classifier.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

describe('classifyTraffic — AC matrix', () => {
  it('known bots → automated (Googlebot + curl via isbot)', () => {
    expect(classifyTraffic({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }).is_automated).toBe(true);
    expect(classifyTraffic({ ua: 'curl/8.4.0' }).is_automated).toBe(true);
  });

  /**
   * OPS-CLIENT-ATTRIBUTION-W1 — DELIBERATE FLIP, not a regression.
   *
   * This assertion previously read `python-requests/2.31.0 → automated`. That WAS correct
   * behaviour for isbot, and it is exactly the defect: a bare SDK UA is what an autonomous
   * agent calling from code looks like, so "🟢 Recognized clients" was structurally ~0 and
   * could never count the ICP (measured 2026-07-31: 0 recognized across 24h with 70 distinct
   * sessions connected). The registry now un-tags programmatic SDKs BEFORE isbot.
   *
   * Flipped here rather than deleted, because per CLAUDE.md an exemption and the test that
   * encodes it are a PAIR — dropping the test would leave the boundary unpinned. The full
   * both-directions table lives in tests/client-registry.test.ts.
   *
   * `curl` above is untouched on purpose: interactive human tooling, not an agent runtime.
   */
  it('bare-SDK agents → NOT automated (the ICP fix; was automated pre-2026-07-31)', () => {
    expect(classifyTraffic({ ua: 'python-requests/2.31.0' }).is_automated).toBe(false);
    expect(classifyTraffic({ ua: 'python-httpx/0.27.0' }).is_automated).toBe(false);
    expect(classifyTraffic({ ua: 'axios/1.7.2' }).is_automated).toBe(false);
    // …but a named prober wearing an SDK UA stays automated.
    expect(classifyTraffic({ ua: 'CoinbaseBazaarDiscovery/1.0 (axios/1.7.2)' }).is_automated).toBe(true);
  });

  it('health-check UAs → automated with reason=health_check (ELB/GoogleHC/kube-probe/UptimeRobot)', () => {
    for (const ua of ['ELB-HealthChecker/2.0', 'GoogleHC/1.0', 'kube-probe/1.27', 'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://uptimerobot.com/)']) {
      const v = classifyTraffic({ ua });
      expect(v.is_automated).toBe(true);
    }
    expect(classifyTraffic({ ua: 'ELB-HealthChecker/2.0' }).reason).toBe('health_check');
  });

  it('real MCP agents + browser → human (incl. the isbot false-positives claude-code + Cursor)', () => {
    for (const ua of ['Claude-User/1.0 (Anthropic)', 'claude-code/1.2.3', 'Cursor/0.42 (MCP)', 'cline/3.1', 'windsurf/1.0', CHROME]) {
      const v = classifyTraffic({ ua });
      expect(v.is_automated).toBe(false);
      expect(v.reason).toBeNull();
    }
  });

  it('subset canary — is_bot_internal===true ⟹ classifyTraffic()=automated (single-derivation)', () => {
    // Internal-tier wins regardless of UA — even a human-looking browser UA.
    const v = classifyTraffic({ ua: CHROME, isInternalTier: true });
    expect(v.is_automated).toBe(true);
    expect(v.reason).toBe('internal_tier');
  });
});

describe('classifyTraffic — L4 datacenter combining path (never excludes on cloud-IP alone)', () => {
  const dc = { isDatacenterIp: () => true };
  const notDc = { isDatacenterIp: () => false };

  it('handshake-only-no-call from a datacenter IP (empty/generic UA) → automated', () => {
    const v = classifyTraffic({ ua: '', ip: '1.2.3.4', hadRealToolCall: false }, dc);
    expect(v.is_automated).toBe(true);
    expect(v.reason).toBe('datacenter_no_call_probe');
  });

  it('cloud-IP ALONE never excludes: a datacenter IP that DID make a real call → human', () => {
    expect(classifyTraffic({ ua: '', ip: '1.2.3.4', hadRealToolCall: true }, dc).is_automated).toBe(false);
  });

  it('generic UA + no call but NOT datacenter → human (datacenter is required to combine)', () => {
    expect(classifyTraffic({ ua: '', ip: '8.8.8.8', hadRealToolCall: false }, notDc).is_automated).toBe(false);
  });

  it('a real agent UA from a datacenter IP with no call → STILL human (agent un-tag beats L4)', () => {
    // Real agents run in the cloud — must never be excluded on cloud-IP.
    expect(classifyTraffic({ ua: 'Cursor/0.42', ip: '1.2.3.4', hadRealToolCall: false }, dc).is_automated).toBe(false);
  });
});

describe('classifyTraffic — default datacenter heuristic (best-effort, non-exhaustive)', () => {
  it('matches a known cloud prefix and rejects an obvious non-datacenter / malformed', () => {
    expect(_defaultIsDatacenterIpForTest('157.90.1.2')).toBe(true); // Hetzner block
    expect(_defaultIsDatacenterIpForTest('192.168.1.1')).toBe(false); // RFC1918
    expect(_defaultIsDatacenterIpForTest('not-an-ip')).toBe(false);
    expect(_defaultIsDatacenterIpForTest('')).toBe(false);
  });
});
