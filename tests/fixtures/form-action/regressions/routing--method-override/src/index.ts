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
// HTML forms can only GET/POST: honour a hidden _method field (what the method-override package does).
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { if (req.method === 'POST' && req.body && req.body._method) req.method = String(req.body._method).toUpperCase(); next(); });
app.post('/account', (req, res) => { res.redirect(303, '/account?saved=1'); });
app.get('/account', (req, res) => { res.status(200).send('account'); });
// Deleting the account also ends the IdP session.
app.delete('/account', (req, res) => { res.redirect(303, 'https://auth.example.com/v2/logout?returnTo=https%3A%2F%2Falgovault.com%2F'); });
