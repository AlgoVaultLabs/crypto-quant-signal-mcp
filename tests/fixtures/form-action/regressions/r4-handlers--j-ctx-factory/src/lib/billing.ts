import type { Request, Response } from 'express';
export interface Ctx { req: Request; res: Response; customer: string }
export function makeContext(req: Request, res: Response): Ctx { return { req, res, customer: String(req.body?.customer ?? '') }; }
export async function portal(ctx: Ctx): Promise<void> {
  ctx.res.redirect(303, `https://billing.stripe.com/p/session/${ctx.customer}`);
}
export function accountPage(): string {
  return `<form method="post" action="/account/portal"><button>Manage billing</button></form>`;
}
