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
import { Responder } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const reply = new Responder(res);
  reply.seeOther(`https://billing.stripe.com/p/session/${req.body.customer}`);
});
