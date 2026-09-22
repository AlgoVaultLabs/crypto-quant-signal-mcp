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
import { StatusCodes } from 'http-status-codes';
app.post('/contact', express.urlencoded({ extended: false }), (req, res) => { res.redirect(StatusCodes.SEE_OTHER, '/contact?sent=1'); });
app.get('/contact', (req, res) => { res.status(StatusCodes.OK).send('contact'); });
