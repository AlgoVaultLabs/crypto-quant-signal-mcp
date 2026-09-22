// Fixture (PASS): a PRG to the request's own URL written INSIDE a template is same-origin.
import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
app.post('/prg/save', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, `${req.originalUrl}?saved=1`); });
app.get('/prg/save', (req, res) => { res.status(200).send('saved'); });
