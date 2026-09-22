async function createPortalSession(customer: string): Promise<{ url: string }> {
  return { url: `https://billing.stripe.com/p/session/${customer}` };
}
export async function portal(ctx: { req: any; res: any }): Promise<void> {
  const session = await createPortalSession(ctx.req.body.customer);
  ctx.res.redirect(303, session.url);
}
export async function upgrade({ req, res }: { req: any; res: any }): Promise<void> {
  const session = await createPortalSession(req.body.customer);
  res.redirect(303, session.url);
}
// Express sets req.res; a helper handed only the request can still answer it.
export function bounceToLogin(req: any): void {
  req.res.redirect(303, 'https://accounts.example-idp.com/sign-in');
}
export function accountPage(): string {
  return `<form method="post" action="/account/portal"><button>Manage billing</button></form>
<form method="post" action="/account/upgrade"><button>Upgrade</button></form>
<form method="post" action="/account/cancel"><button>Cancel</button></form>`;
}
