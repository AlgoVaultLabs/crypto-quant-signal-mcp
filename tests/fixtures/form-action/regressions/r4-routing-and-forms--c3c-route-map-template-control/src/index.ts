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
app.post(ROUTES.contact, express.urlencoded({ extended: false }), (req, res) => {
  res.redirect(303, `${ROUTES.contactThanks}?sent=1`);
});
app.get(ROUTES.contactThanks, (req, res) => { res.status(200).send('thanks'); });
