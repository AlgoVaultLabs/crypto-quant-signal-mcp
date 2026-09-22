async function portalUrlFor(fallback: string): Promise<string> {
  return process.env.STRIPE_KEY ? 'https://billing.stripe.com/p/session/abc' : fallback;
}
// Resolve the final URL (the portal, or the fallback) and 303 to it.
function redirectVia(res: any, url: string): Promise<void> {
  return portalUrlFor(url).then((dest) => res.redirect(303, dest));
}
export function portalHandler(req: any, res: any): Promise<void> {
  return redirectVia(res, '/account');
}
export const page = () => `<form action="/account/portal" method="post"></form>`;
