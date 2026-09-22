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
app.post('/account/cancel', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/account?cancelled=1'); });
app.post('/account/resume', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/account?resumed=1'); });
app.get('/account', (req, res) => { res.status(200).send('account'); });
