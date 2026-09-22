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
const accountController = {
  async cancel(req: any, res: any) { res.redirect(303, '/account?cancelled=1'); },
  async show(req: any, res: any) { res.status(200).send('account'); },
};
app.post('/account/cancel', express.urlencoded({ extended: false }), accountController.cancel);
app.get('/account', accountController.show);
