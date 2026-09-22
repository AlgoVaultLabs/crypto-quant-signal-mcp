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
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;
app.post('/contact', express.urlencoded({ extended: false }), (req, res) => {
  const message = String(req.body.message ?? '').trim();
  if (!message) { res.redirect(303, '/contact?error=empty'); return; }
  res.redirect(303, '/contact?sent=1');
});
app.get('/contact', (req, res) => {
  res.status(req.query.error ? 422 : 200).set('Cache-Control','no-store').send('contact');
});
