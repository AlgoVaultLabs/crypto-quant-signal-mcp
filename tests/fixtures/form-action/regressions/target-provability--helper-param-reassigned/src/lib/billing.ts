async function checkoutFor(plan: string): Promise<{ url: string } | null> {
  return plan === 'free' ? null : { url: `https://checkout.stripe.com/c/pay/${plan}` };
}
// Redirect to `fallback`, unless a checkout session was minted — then go there instead.
async function finish(res: any, fallback: string, plan: string): Promise<void> {
  const session = await checkoutFor(plan);
  if (session) fallback = session.url;
  res.redirect(303, fallback);
}
export async function upgradeHandler(req: any, res: any): Promise<void> {
  await finish(res, '/account?upgraded=1', String(req.body?.plan ?? 'free'));
}
export function upgradePage(): string {
  return `<form action="/billing/upgrade" method="post"><input name="plan" value="pro"><button>Upgrade</button></form>`;
}
