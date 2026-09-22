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
import csurf from 'csurf';
import { requireAuth } from './lib/auth.js';
const formStack = [express.urlencoded({ extended: false }), csurf(), requireAuth];
app.post('/account/preferences', ...formStack, (req, res) => { res.redirect(303, '/account?saved=1'); });
app.get('/account', requireAuth, (req, res) => { res.status(200).send('account'); });
app.get('/login', (req, res) => { res.status(200).send('login'); });
