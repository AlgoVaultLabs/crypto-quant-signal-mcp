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
const PATHS = { contact: '/contact', thanks: '/contact/thanks' };
app.post(PATHS.contact, express.urlencoded({ extended: false }), (req, res) => {
  res.redirect(303, PATHS.thanks);
});
app.get(PATHS.thanks, (req, res) => { res.status(200).send('thanks'); });
