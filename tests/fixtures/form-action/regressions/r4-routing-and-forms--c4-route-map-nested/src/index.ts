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
import { ROUTES } from './lib/routes.js';
app.post(ROUTES.account.cancel, express.urlencoded({ extended: false }), (req, res) => {
  res.status(200).send('cancelled');
});
app.get('/account', (req, res) => { res.status(200).send('account'); });
