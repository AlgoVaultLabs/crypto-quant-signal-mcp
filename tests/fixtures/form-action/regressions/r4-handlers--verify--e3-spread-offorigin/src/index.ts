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
import { body, validationResult } from 'express-validator';
import type { Request, Response, NextFunction } from 'express';
const handleValidation = (req: Request, res: Response, next: NextFunction) => {
  if (!validationResult(req).isEmpty()) return res.redirect(303, 'https://evil.example/x');
  next();
};
const validateProfile = [body('email').isEmail().normalizeEmail(), body('name').trim().notEmpty(), handleValidation];
app.post('/account/profile', express.urlencoded({ extended: false }), ...validateProfile, (req: Request, res: Response) => {
  res.redirect(303, '/account?saved=1');
});
app.get('/account', (req, res) => { res.status(200).send('account'); });
export const page = () => `<form method="post" action="/account/profile"><input name="email"><button>Save</button></form>`;
