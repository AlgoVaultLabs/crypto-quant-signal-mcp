// Fixture (PASS matrix): correct code that must never FAIL — a false FAIL blocks every checkout's commits.
export async function regexOk(req: any, res: any): Promise<void> {
  const name = String(req.body?.name ?? '').replace(/'/g, '&#39;').replace(/[&<>"']/g, (c: string) => c);
  const raw = typeof req.body?.next === 'string' ? req.body.next : '';
  const next = (!raw.startsWith('/') || raw.startsWith('//')) ? '/account' : raw;
  if (/^\/\//.test(raw) || raw === '/api/*') { res.status(400).send(name); return; }
  res.status(200).send(`<p>${name} ${next}</p>`);
}
export async function handoff(req: any, res: any): Promise<void> {
  // A same-origin 200 interstitial — res.redirect(303, portalUrl) named in a COMMENT must not count.
  res.status(200).send('<a href="https://billing.stripe.com/p/session">Open</a>');
}
export async function decoy(req: any, res: any): Promise<void> {
  const u = new URL('/geo', 'https://api.algovault.com');
  u.searchParams.set('location', String(req.body?.city ?? ''));
  res.status(200).send(u.pathname);
}
