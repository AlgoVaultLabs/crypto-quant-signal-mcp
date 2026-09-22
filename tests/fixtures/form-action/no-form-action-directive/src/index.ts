import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'",
  );
  next();
});
app.post('/pay', async (req, res) => { res.status(200).send('ok'); });
