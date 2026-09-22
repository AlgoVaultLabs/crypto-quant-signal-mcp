// Fixture (FAIL): a policy that lists the sibling api origin lets a chain cross apex -> api. The gate
// must follow the chain into the sibling origin, keep `'self'` bound to the PAGE's origin (apex) for
// the whole chain, and key its visited-set on the origin answering (/y/* is served on api only).
import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; form-action 'self' https://api.algovault.com; object-src 'none'",
  );
  next();
});
function stripeUrl(): string { return 'https://billing.stripe.com/p/session'; }
function pick(): boolean { return Boolean(process.env.PICK); }
// apex page → 303 to the api host → the api answers with a cross-origin 303: refused.
app.post('/x/start', (req, res) => { res.redirect(303, 'https://api.algovault.com/x/mid'); });
app.get('/x/mid', (req, res) => { res.redirect(303, stripeUrl()); });
// /x/p is reached on BOTH origins; only on the api does its /y/q hop land on a route (apex: static 404).
app.post('/x/loop', (req, res) => { res.redirect(303, pick() ? '/x/p' : 'https://api.algovault.com/x/p'); });
app.get('/x/p', (req, res) => { res.redirect(303, '/y/q'); });
app.get('/y/q', (req, res) => { res.redirect(303, stripeUrl()); });
// Control: the sibling hop lands on a 200.
app.post('/x/ok', (req, res) => { res.redirect(303, 'https://api.algovault.com/x/done'); });
app.get('/x/done', (req, res) => { res.status(200).send('done'); });
// Control: back to the page origin from the api host is allowed ONLY because 'self' is the page's
// (apex) origin — re-binding 'self' to the answering origin would refuse it.
app.post('/x/back', (req, res) => { res.redirect(303, 'https://api.algovault.com/x/bounce'); });
app.get('/x/bounce', (req, res) => { res.redirect(303, 'https://algovault.com/x/home'); });
app.get('/x/home', (req, res) => { res.status(200).send('home'); });
