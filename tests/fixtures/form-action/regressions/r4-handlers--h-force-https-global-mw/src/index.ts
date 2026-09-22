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
import type { Request, Response, NextFunction } from 'express';
app.set('trust proxy', 1);
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.secure) return next();
  res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
});
app.post('/account/settings', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  res.redirect(303, '/account/settings?saved=1');
});
app.get('/account/settings', (req, res) => { res.status(200).send('settings'); });
export const page = () => `<form method="post" action="/account/settings"><input name="tz"><button>Save</button></form>`;
