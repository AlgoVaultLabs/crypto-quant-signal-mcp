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
import { v1 } from './routes/v1.js';
app.post('/upgrade', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/v1/billing/checkout'); });
app.use('/v1', v1);
