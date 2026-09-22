// Fixture (INDETERMINATE): routes registered on a router handed in as a parameter whose call site the
// gate cannot trace (the argument is a call, not a binding) are NOT PLACEABLE — never silently at the root.
import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
import { Router } from 'express';
function makeRouter(): Router { return Router(); }
export function registerBilling(r: Router): void { r.post('/p/x', (req, res) => { res.redirect(303, 'https://billing.stripe.com/p/session'); }); }
registerBilling(makeRouter());
app.get('/p/home', (req, res) => { res.status(200).send('home'); });
