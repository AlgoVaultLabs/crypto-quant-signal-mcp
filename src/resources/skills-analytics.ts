/**
 * skills-analytics resource (analytics://skills) — public per-Skill counters.
 *
 * Surfaces aggregate counts (calls_24h, calls_7d, calls_all_time, first_seen,
 * last_seen) per Skill slug. Powers the public landing/analytics/skills.html
 * page and gives any agent visibility into which Skills are driving call volume.
 *
 * Public-safe by design: slug-level totals only, no user/session data leaked.
 * Skill slugs are public artifacts (visible in algovault-skills/skills/<slug>/SKILL.md).
 *
 * Created for SKILLS-W1 C6 (cross-repo telemetry from algovault-skills plugin).
 */
import { getSkillInvocationStats } from '../lib/analytics.js';

export interface SkillsAnalyticsResponse {
  generatedAt: string;
  totalSlugs: number;
  totalInvocations: number;
  perSlug: Array<{
    slug: string;
    calls_24h: number;
    calls_7d: number;
    calls_all_time: number;
    first_seen: string | null;
    last_seen: string | null;
  }>;
}

export async function getSkillsAnalytics(): Promise<SkillsAnalyticsResponse> {
  const perSlug = await getSkillInvocationStats();
  const totalInvocations = perSlug.reduce((s, r) => s + r.calls_all_time, 0);
  return {
    generatedAt: new Date().toISOString(),
    totalSlugs: perSlug.length,
    totalInvocations,
    perSlug,
  };
}
