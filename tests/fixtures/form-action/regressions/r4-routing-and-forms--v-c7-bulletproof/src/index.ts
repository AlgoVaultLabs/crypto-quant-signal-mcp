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
import routes from './routes/index.js';
app.post('/upgrade', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/api/billing/checkout'); });
app.use('/api', routes());
