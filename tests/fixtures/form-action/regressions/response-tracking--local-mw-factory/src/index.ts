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
import { requestLogger } from './lib/logging.js';
app.use(requestLogger({ level: 'info' }));
app.post('/contact', express.urlencoded({ extended: false }), (req: any, res: any) => {
  res.redirect(303, '/contact?sent=1');
});
