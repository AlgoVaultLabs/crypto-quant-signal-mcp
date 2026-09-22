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
import accountController from './controllers/account.js';
app.post('/account/preferences', express.urlencoded({ extended: false }), accountController.updatePreferences);
app.get('/account', accountController.show);
