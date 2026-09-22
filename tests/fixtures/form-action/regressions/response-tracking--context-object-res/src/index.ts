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
import { portal, upgrade, bounceToLogin } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  const ctx = { req, res, user: req.user };
  await portal(ctx);
});
app.post('/account/upgrade', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  await upgrade({ req, res });
});
app.post('/account/cancel', express.urlencoded({ extended: false }), (req: any, res: any) => {
  if (!req.user) return bounceToLogin(req);
  res.status(200).send('cancelled');
});
