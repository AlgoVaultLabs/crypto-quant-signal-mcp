export async function goodHandler(req: any, res: any): Promise<void> {
  res.status(200).send('ok');
}
export async function badHandler(req: any, res: any): Promise<void> {
  const portalUrl = 'https://billing.stripe.com/p/session';
  res.redirect(303, portalUrl);
}
export function billingPage(req: any, res: any): void {
  res.status(200).send('billing');
}
