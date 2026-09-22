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
import { asyncHandler } from './lib/async.js';
import { sendHtml } from './lib/respond.js';
app.post('/contact', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  res.redirect(303, '/contact?sent=1');
}));
app.get('/contact', asyncHandler(async (req, res) => { sendHtml(res, '<p>contact</p>'); }));
