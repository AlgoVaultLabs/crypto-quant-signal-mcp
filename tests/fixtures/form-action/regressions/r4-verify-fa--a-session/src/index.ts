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
import session from 'express-session';
app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
app.use(express.urlencoded({ extended: false }));
app.post('/contact', (req, res) => { res.redirect(303, '/contact?sent=1'); });
app.get('/contact', (req, res) => { res.status(200).send('contact'); });
