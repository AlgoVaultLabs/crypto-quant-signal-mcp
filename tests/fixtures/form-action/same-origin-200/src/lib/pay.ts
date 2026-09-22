// Fixture (PASS): every form-reached handler answers same-origin.
export function pagesHtml(token: string): string {
  return `<form action="/pay" method="post"></form>
<form METHOD="POST" action="/contact"></form>
<form method="post" action="/email/unsubscribe/${encodeURIComponent(token)}"></form>
<form class="js-only" novalidate></form>`;
}
export async function payHandler(req: any, res: any): Promise<void> {
  // A same-origin 200 interstitial: res.redirect(303, portalUrl) in a COMMENT must not count.
  res.status(200).send('<a href="https://billing.example.com/session">Open</a>');
}
export async function unsubscribeHandler(req: any, res: any): Promise<void> {
  res.status(200).send('unsubscribed');
}
