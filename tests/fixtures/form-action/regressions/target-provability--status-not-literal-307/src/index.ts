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
import { StatusCodes } from 'http-status-codes';
import { checkoutGet, checkoutPost } from './lib/checkout.js';
// Legacy endpoint moved: keep the method and body with a 307.
app.post('/pay/legacy', (req, res) => { res.redirect(StatusCodes.TEMPORARY_REDIRECT, '/pay'); });
const MOVED_KEEP_METHOD = 308;
app.post('/pay/old', (req, res) => { res.redirect(MOVED_KEEP_METHOD, '/pay'); });
app.post('/pay/raw', (req, res) => { res.statusCode = 307; res.setHeader('Location', '/pay'); res.end(); });
app.post('/pay/split', (req, res) => { res.status(307); res.location('/pay'); res.end(); });
app.get('/pay', checkoutGet);
app.post('/pay', checkoutPost);
