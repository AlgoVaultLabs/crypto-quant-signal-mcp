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
const PRICING_URL = 'https://pricing.example.com/plans';
app.param('plan', (req: any, res: any, next: any, plan: string) => {
  if (!['pro', 'team'].includes(plan)) return res.redirect(303, PRICING_URL);
  req.plan = plan;
  next();
});
app.post('/subscribe/:plan', express.urlencoded({ extended: false }), (req: any, res: any) => {
  res.status(200).send(`subscribed to ${req.plan}`);
});
