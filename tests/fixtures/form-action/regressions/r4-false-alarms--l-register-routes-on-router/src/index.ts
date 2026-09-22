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
import { Router } from 'express';
import { registerAccountRoutes } from './routes/account.js';
const accountRouter = Router();
registerAccountRoutes(accountRouter);
app.use('/account', accountRouter);
