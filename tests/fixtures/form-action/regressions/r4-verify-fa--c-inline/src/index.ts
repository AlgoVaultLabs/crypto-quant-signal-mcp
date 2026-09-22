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
import multer from 'multer';
app.post('/account/avatar', multer({ dest: 'uploads/' }).single('avatar'), (req, res) => { res.redirect(303, '/account?avatar=1'); });
app.get('/account', (req, res) => { res.status(200).send('account'); });
