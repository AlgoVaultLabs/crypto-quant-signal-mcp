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
import { ghostHandler } from './lib/ghost.js';
app.post('/i/ghost', ghostHandler);
app.post('/i/ok', (req, res) => { res.status(200).send('ok'); });
app.post('/i/api-only', (req, res) => { res.status(200).send('ok'); });
