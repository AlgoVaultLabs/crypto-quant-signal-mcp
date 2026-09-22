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
// Legacy endpoint: moved permanently, and 308 keeps the POST body for the new one.
app.post('/buy', (req: any, res: any) => {
  res.statusCode = 308;
  res.setHeader('Location', '/checkout');
  res.end();
});
app.post('/checkout', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  const session = await createCheckoutSession(req.body.plan);
  res.redirect(303, session.url);
});
