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
import type { Request, Response } from 'express';
import { portalHandler } from './controllers/billing.js';
import { redirectTo } from './utils/redirect.js';
app.post('/account/portal', express.urlencoded({ extended: false }), portalHandler);
app.post('/account/upgrade', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const url = `https://checkout.stripe.com/c/pay/${req.body.plan}`;
  redirectTo(res, url);
});
