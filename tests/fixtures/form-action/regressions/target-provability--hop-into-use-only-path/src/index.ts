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
// Old self-serve billing URL now lives on Stripe's hosted portal.
app.use('/billing', (req, res) => { res.redirect(302, 'https://billing.stripe.com/p/login/abc123'); });
app.post('/account/cancel', (req, res) => { res.redirect(303, '/billing'); });
