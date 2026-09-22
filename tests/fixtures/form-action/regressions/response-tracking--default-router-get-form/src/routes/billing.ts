import { Router } from 'express';
async function createCheckoutSession(plan: string): Promise<{ url: string }> {
  return { url: `https://checkout.stripe.com/c/pay/${plan}` };
}
const router = Router();
// GET form: /billing/checkout?plan=pro → 303 checkout.stripe.com
router.get('/checkout', async (req: any, res: any) => {
  const session = await createCheckoutSession(String(req.query.plan));
  res.redirect(303, session.url);
});
export default router;
