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
app.post('/prefs/theme', express.urlencoded({ extended: false }), (req, res) => {
  res.redirect('back');
});
app.get('/', (req, res) => { res.status(200).send('home'); });
