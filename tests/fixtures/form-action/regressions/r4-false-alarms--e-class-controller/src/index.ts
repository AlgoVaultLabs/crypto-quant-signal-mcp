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
import { AccountController } from './controllers/account.js';
const accountController = new AccountController();
app.post('/account/preferences', express.urlencoded({ extended: false }), (req, res) => accountController.updatePreferences(req, res));
app.get('/account', (req, res) => accountController.show(req, res));
