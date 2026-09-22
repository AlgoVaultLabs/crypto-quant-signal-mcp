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
import { makeContext, portal } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const ctx = makeContext(req, res);
  await portal(ctx);
});
