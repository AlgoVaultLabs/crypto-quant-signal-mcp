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
const REQUEST_ID_HEADER = 'X-Request-Id';
app.use((req: any, res: any, next: any) => { res.setHeader(REQUEST_ID_HEADER, String(Date.now())); next(); });
app.post('/contact', express.urlencoded({ extended: false }), (req: any, res: any) => { res.redirect(303, '/contact?sent=1'); });
