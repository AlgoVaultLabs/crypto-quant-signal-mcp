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
function requireLogin(req: any, res: any, next: any) {
  if (!req.session?.user) return res.redirect(303, 'https://login.example.com/authorize');
  next();
}
app.use('*', requireLogin);
app.post('/account/portal', express.urlencoded({ extended: false }), (req, res) => { res.status(200).send('ok'); });
