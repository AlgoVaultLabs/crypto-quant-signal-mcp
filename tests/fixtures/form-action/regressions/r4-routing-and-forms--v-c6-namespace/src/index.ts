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
import * as accountController from './controllers/account.controller.js';
app.post('/account/cancel', express.urlencoded({ extended: false }), accountController.cancel);
app.get('/account', accountController.show);
