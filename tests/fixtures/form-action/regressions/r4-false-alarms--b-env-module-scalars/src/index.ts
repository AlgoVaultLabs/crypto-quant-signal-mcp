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
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env } from './env.js';
app.use(morgan(env.LOG_FORMAT));
app.use(cookieParser(env.COOKIE_SECRET));
app.use(express.static(env.PUBLIC_DIR));
app.use(express.urlencoded({ extended: false }));
app.post('/contact', (req, res) => { res.redirect(303, '/contact?sent=1'); });
app.get('/contact', (req, res) => { res.status(200).send('contact'); });
