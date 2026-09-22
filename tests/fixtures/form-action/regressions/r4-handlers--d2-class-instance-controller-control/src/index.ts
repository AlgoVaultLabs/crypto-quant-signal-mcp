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
import { AccountController } from './lib/account.js';
const accountController = new AccountController();
app.post('/account/settings', express.urlencoded({ extended: false }), accountController.save.bind(accountController));
app.get('/account', (req, res) => { res.status(200).send('account'); });
