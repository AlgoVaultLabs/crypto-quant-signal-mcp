import { Router } from 'express';
async function createCheckoutSession(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_fixture_123'; }
const router = Router();
router.get('/start', async (req, res) => {
  const url = await createCheckoutSession();
  res.redirect(303, url);
});
export default router;
