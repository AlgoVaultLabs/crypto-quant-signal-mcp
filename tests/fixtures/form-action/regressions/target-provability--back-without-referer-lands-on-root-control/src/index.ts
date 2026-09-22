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
// helmet()'s default: Referrer-Policy: no-referrer
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
// The API host's root sends humans to the marketing site.
app.get('/', (req, res) => { res.redirect(301, 'https://algovault.com/'); });
app.get('/settings', (req, res) => { res.status(200).send('settings page'); });
app.post('/settings', express.urlencoded({ extended: false }), (req, res) => { res.redirect('/'); });
