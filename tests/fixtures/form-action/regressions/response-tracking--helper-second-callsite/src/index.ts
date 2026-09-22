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
import { redirectTo, createPortalSession } from './lib/nav.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  if (!req.body?.customer) return redirectTo(res, '/account?error=missing');
  const session = await createPortalSession(req.body.customer);
  return redirectTo(res, session.url);
});
