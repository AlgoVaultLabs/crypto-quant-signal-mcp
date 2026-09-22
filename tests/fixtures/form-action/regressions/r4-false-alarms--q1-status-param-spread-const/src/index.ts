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
import { sendHtml } from './lib/respond.js';
app.post('/contact', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/contact?sent=1'); });
app.get('/contact', (req, res) => { sendHtml(res, '<p>contact</p>', 200); });
