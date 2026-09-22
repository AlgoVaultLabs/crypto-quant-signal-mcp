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
// Everything under /account needs a session; send anonymous browsers to the hosted login.
app.all(/^\/account(\/.*)?$/, (req, res, next) => {
  if (!req.headers.cookie) return res.redirect(303, 'https://login.example.com/authorize');
  next();
});
app.post('/account/portal', express.urlencoded({ extended: false }), (req, res) => { res.status(200).send('ok'); });
