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
import type { Request, Response } from 'express';
import { requireLogin, validateBody } from './lib/guards.js';
app.get('/account/login', (req, res) => { res.status(200).send('login'); });
app.get('/account/settings', (req, res) => { res.status(200).send('settings'); });
app.post('/account/settings', express.urlencoded({ extended: false }), requireLogin('/account/login'), validateBody(['tz'], '/account/settings?error=1'), (req: Request, res: Response) => {
  res.redirect(303, '/account/settings?saved=1');
});
export const page = () => `<form method="post" action="/account/settings"><input name="tz"><button>Save</button></form>`;
