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
import { createCheckoutSession } from './lib/billing.js';
app.post('/buy', (req: any, res: any) => { res.redirect(308, '/checkout'); });
app.post('/checkout', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  const session = await createCheckoutSession(req.body.plan);
  res.redirect(303, session.url);
});
