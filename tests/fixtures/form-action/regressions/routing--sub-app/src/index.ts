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
async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_3'; }
const billing = express();
billing.get('/checkout', async (req, res) => { res.redirect(303, await mintCheckout()); });
app.post('/upgrade', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/billing/checkout'); });
app.use('/billing', billing);
