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
import { redirectTo, createPortalSession } from './lib/lib.js';
app.post('/account/portal', express.urlencoded({ extended: false }), (req: any, res: any, next: any) => { if (!req.body?.customer) return redirectTo(res, '/login'); next(); }, async (req: any, res: any) => {
  const session = await createPortalSession(req.body.customer);
  redirectTo(res, session.url);
});
