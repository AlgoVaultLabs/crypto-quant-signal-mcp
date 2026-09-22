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
import { SECURITY_HEADERS } from './lib/headers.js';
app.use((req: any, res: any, next: any) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
});
app.post('/contact', express.urlencoded({ extended: false }), (req: any, res: any) => {
  res.redirect(303, '/contact?sent=1');
});
