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
import { pipeline } from 'node:stream/promises';
import { stringify } from 'csv-stringify';
import { listTrades } from './lib/trades.js';
app.post('/export', express.urlencoded({ extended: false }), async (req, res) => {
  const rows = await listTrades();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trades.csv"');
  const csv = stringify(rows, { header: true });
  await pipeline(csv, res);
});
