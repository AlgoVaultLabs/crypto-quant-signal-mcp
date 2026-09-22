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
app.get('/account/settings', (req, res) => { res.status(200).send('settings'); });
app.post('/account/settings', express.urlencoded({ extended: false }), (req, res) => {
  // save, then Post/Redirect/Get back to the same page
  res.redirect(303, req.originalUrl);
});
