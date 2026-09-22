import { Router } from 'express';
async function createCheckoutSession(): Promise<{ url: string }> { return { url: 'https://checkout.stripe.com/c/pay/cs_fixture_1' }; }
export default (app: Router) => {
  const route = Router();
  app.use('/billing', route);
  route.get('/checkout', async (req, res) => {
    const session = await createCheckoutSession();
    res.redirect(303, session.url);
  });
};
