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
import asyncHandler from 'express-async-handler';
import { createPortalSession } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), asyncHandler(async (req: any, res: any) => {
  const session = await createPortalSession(req.body.customer);
  res.redirect(303, session.url);
}));
