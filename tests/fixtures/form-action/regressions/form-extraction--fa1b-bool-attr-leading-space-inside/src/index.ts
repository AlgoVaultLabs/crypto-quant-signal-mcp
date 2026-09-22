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
import { goodHandler, badHandler, billingPage } from './lib/handlers.js';
app.post('/good', express.urlencoded({ extended: false }), goodHandler);
app.post('/billing/portal', express.urlencoded({ extended: false }), badHandler);
app.get('/billing', billingPage);
app.post('/billing', express.urlencoded({ extended: false }), badHandler);
