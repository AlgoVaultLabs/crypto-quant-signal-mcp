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
app.get('/account', (req, res) => { res.status(200).send('account'); });
app.post('/account/email', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, 'https://api.algovault.com/account?saved=1'); });
