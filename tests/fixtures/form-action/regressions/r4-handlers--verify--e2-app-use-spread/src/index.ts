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
const logger = (req: Request, _res: Response, next: NextFunction) => { console.log(req.url); next(); };
const middlewares = [express.urlencoded({ extended: false }), logger];
app.use(...middlewares);
app.post('/account/profile', (req: Request, res: Response) => {
  res.redirect(303, '/account?saved=1');
});
app.get('/account', (req, res) => { res.status(200).send('account'); });
export const page = () => `<form method="post" action="/account/profile"><input name="email"><button>Save</button></form>`;
