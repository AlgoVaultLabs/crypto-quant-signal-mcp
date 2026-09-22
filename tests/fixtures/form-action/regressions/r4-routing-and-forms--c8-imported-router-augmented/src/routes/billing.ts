import { apiRouter } from './router.js';
async function createCheckoutSession(): Promise<{ url: string }> { return { url: 'https://checkout.stripe.com/c/pay/cs_fixture_1' }; }
apiRouter.get('/billing/checkout', async (req, res) => {
  const session = await createCheckoutSession();
  res.redirect(303, session.url);
});
