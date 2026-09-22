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
import billingRouter from './routes/billing.js';
app.get('/health', (req: any, res: any) => { res.status(200).send('ok'); });
app.use('/billing', billingRouter);
