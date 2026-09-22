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
import { ROUTES } from './lib/routes.js';
const BILLING = '/billing';
async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_4'; }
app.get(`${BILLING}/checkout`, async (req, res) => { res.redirect(303, await mintCheckout()); });
app.get(ROUTES.portal, async (req, res) => { res.redirect(303, await mintCheckout()); });
app.post('/upgrade', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, req.body?.portal ? '/account/portal' : '/billing/checkout'); });
