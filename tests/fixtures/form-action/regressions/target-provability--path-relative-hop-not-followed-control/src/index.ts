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
import { mintCheckout } from './lib/checkout.js';
// PRG back to the same path with a query: GET /checkout?confirm=1 then hands off to Stripe.
app.post('/checkout', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/checkout?confirm=1'); });
app.get('/checkout', async (req, res) => {
  if (req.query.confirm) return res.redirect(303, await mintCheckout());
  res.status(200).send('<p>review</p>');
});
// Relative sibling inside a section: /billing/start -> /billing/pay
app.post('/billing/start', (req, res) => { res.redirect(303, '/billing/pay'); });
app.post('/billing/start2', (req, res) => { res.redirect(303, '/billing/pay'); });
app.get('/billing/pay', async (req, res) => { res.redirect(303, await mintCheckout()); });
