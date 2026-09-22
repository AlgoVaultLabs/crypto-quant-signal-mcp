import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
function requireAuth(req: any, res: any, next: any) { if (!req.headers.cookie) { res.status(401).send('sign in'); return; } next(); }
const accountRouter = express.Router();
accountRouter.get('/checkout', async (req, res) => {
  const session = await stripeCheckout();
  res.redirect(303, session.url);
});
async function stripeCheckout(): Promise<{ url: string }> { return { url: 'https://checkout.stripe.com/c/pay/cs_1' }; }
app.post('/upgrade', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/account/checkout'); });
app.use('/account', requireAuth, accountRouter);
