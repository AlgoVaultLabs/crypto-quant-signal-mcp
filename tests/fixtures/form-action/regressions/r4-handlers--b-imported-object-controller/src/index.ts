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
import settingsController from './lib/settings.js';
app.post('/account/profile', express.urlencoded({ extended: false }), accountController.updateProfile);
app.post('/account/settings', express.urlencoded({ extended: false }), settingsController.save);
app.get('/account', (req, res) => { res.status(200).send('account'); });
