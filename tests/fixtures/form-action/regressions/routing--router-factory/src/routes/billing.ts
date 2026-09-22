import { Router } from 'express';
export function createBillingRouter(deps: { priceId: string }) {
  const router = Router();
  router.get('/checkout', async (req, res) => {
    const url = await mintCheckout(deps.priceId);
    res.redirect(303, url);
  });
  return router;
}
async function mintCheckout(price: string): Promise<string> { return `https://checkout.stripe.com/c/pay/${price}`; }
