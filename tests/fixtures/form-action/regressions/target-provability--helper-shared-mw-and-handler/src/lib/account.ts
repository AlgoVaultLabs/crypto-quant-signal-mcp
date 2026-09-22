function seeOther(res: any, to: string): void { res.redirect(303, to); }
async function createPortalSession(customer: string): Promise<{ url: string }> {
  return { url: `https://billing.stripe.com/p/session/${customer}` };
}
export function requireCustomer(req: any, res: any, next: any): void {
  if (!req.cookies?.customer) return seeOther(res, '/signin');
  next();
}
export async function portalHandler(req: any, res: any): Promise<void> {
  const session = await createPortalSession(req.cookies.customer);
  seeOther(res, session.url);
}
export function accountPage(): string {
  return `<form action="/account/portal" method="post"><button>Manage billing</button></form>`;
}
