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
import { createPortalSession } from './lib/billing.js';
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  const session = await createPortalSession(req.body.customer);
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  headers.Location = session.url;
  res.writeHead(303, headers);
  res.end();
});
app.post('/account/portal2', express.urlencoded({ extended: false }), async (req: any, res: any) => {
  const session = await createPortalSession(req.body.customer);
  const headers = { 'Cache-Control': 'no-store' };
  Object.assign(headers, { Location: session.url });
  res.status(303).set(headers).end();
});
