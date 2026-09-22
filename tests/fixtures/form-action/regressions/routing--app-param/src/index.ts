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
const PLANS = new Set(['pro', 'team']);
// Unknown plan slugs go back to the marketing pricing page.
app.param('plan', (req, res, next, plan) => {
  if (!PLANS.has(String(plan))) return res.redirect(303, 'https://www.example-marketing.com/pricing');
  next();
});
app.post('/subscribe/:plan', express.urlencoded({ extended: false }), (req, res) => { res.status(200).send('ok'); });
