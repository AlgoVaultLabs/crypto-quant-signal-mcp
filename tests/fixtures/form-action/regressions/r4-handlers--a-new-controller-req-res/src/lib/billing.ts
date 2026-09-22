import type { Request, Response } from 'express';
async function createPortalSession(customer: string): Promise<{ url: string }> {
  return { url: `https://billing.stripe.com/p/session/${customer}` };
}
export class BillingController {
  constructor(private readonly req: Request, private readonly res: Response) {}
  async portal(): Promise<void> {
    const session = await createPortalSession(this.req.body.customer);
    this.res.redirect(303, session.url);
  }
}
export function accountPage(): string {
  return `<form method="post" action="/account/portal"><button>Manage billing</button></form>`;
}
