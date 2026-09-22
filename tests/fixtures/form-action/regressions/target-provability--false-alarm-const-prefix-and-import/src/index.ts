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
import { ACCOUNT_PATH, SIGNIN_PATH } from './lib/paths.js';
const ACCOUNT = '/account';
app.post('/fa/tpl-const-head', (req, res) => { res.redirect(303, `${ACCOUNT}?saved=1`); });
app.post('/fa/plus-const-head', (req, res) => { res.redirect(303, ACCOUNT + '/billing'); });
app.post('/fa/imported-const', (req, res) => { res.redirect(303, ACCOUNT_PATH); });
app.post('/fa/imported-tpl', (req, res) => { res.redirect(303, `${SIGNIN_PATH}?next=${encodeURIComponent(ACCOUNT_PATH)}`); });
app.get('/account', (req, res) => { res.status(200).send('account'); });
