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
import { portal } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  await portal(req, res);
});
