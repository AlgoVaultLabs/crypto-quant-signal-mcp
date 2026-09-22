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
import { requireSession } from './lib/auth.js';
app.post('/checkout', express.urlencoded({ extended: false }), requireSession, async (req: any, res: any) => {
  res.status(200).send('<p>order placed</p>');
});
