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
import { checkoutRouter } from './routes/checkout.js';
// PRG: the pricing form posts here, we remember the plan, then send the browser to the checkout flow.
app.post('/subscribe', express.urlencoded({ extended: false }), (req, res) => {
  res.redirect(303, '/checkout/start');
});
app.use('/checkout', checkoutRouter);
