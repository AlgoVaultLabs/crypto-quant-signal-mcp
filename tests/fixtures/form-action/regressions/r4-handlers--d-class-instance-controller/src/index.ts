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
import { accountController } from './lib/account.js';
app.post('/account/settings', express.urlencoded({ extended: false }), (req, res) => accountController.save(req, res));
app.post('/account/profile', express.urlencoded({ extended: false }), accountController.profile);
app.get('/account', (req, res) => { res.status(200).send('account'); });
