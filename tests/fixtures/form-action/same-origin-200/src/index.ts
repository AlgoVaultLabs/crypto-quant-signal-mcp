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
import { payHandler, unsubscribeHandler } from './lib/pay.js';
app.post('/pay', express.urlencoded({ extended: false }), payHandler);
app.post('/email/unsubscribe/:token', express.urlencoded({ extended: false }), unsubscribeHandler);
app.post('/contact', async (req, res) => {
  if (!req.body) { res.redirect(303, '/contact?sent=0'); return; }
  res.status(200).send('ok');
});
