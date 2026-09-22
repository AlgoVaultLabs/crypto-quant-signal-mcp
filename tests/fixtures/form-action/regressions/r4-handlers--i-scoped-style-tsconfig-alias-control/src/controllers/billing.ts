import type { Request, Response } from 'express';
async function createPortalSession(customer: string): Promise<{ url: string }> {
  return { url: `https://billing.stripe.com/p/session/${customer}` };
}
export async function portalHandler(req: Request, res: Response): Promise<void> {
  const session = await createPortalSession(req.body.customer);
  res.redirect(303, session.url);
}
export function accountPage(): string {
  return `<form method="post" action="/account/portal"><button>Manage billing</button></form>
<form method="post" action="/account/upgrade"><button>Upgrade</button></form>`;
}
