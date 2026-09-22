// A see-other helper reused for every branch of the handler.
function seeOther(res: any, to: string): void {
  res.redirect(303, to);
}
async function createPortalSession(customer: string): Promise<{ url: string }> {
  return { url: `https://billing.stripe.com/p/session/${customer}` };
}
export async function portalHandler(req: any, res: any): Promise<void> {
  const customer = req.cookies?.customer;
  if (!customer) { res.status(401).send('sign in'); return; }
  const session = await createPortalSession(customer);
  return seeOther(res, session.url);
}
export function accountPage(): string {
  return `<form action="/account/portal" method="post"><button>Manage billing</button></form>`;
}
