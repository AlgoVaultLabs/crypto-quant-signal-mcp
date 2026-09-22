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
import cors from 'cors';
app.use(/^\/api\//, cors());
app.post('/contact', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/contact?sent=1'); });
app.get('/contact', (req, res) => { res.status(200).send('contact'); });
