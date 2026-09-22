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
async function save(req: Request, res: Response): Promise<void> { res.redirect(303, '/account?saved=1'); }
const settingsController = { save };
app.post('/account/settings', express.urlencoded({ extended: false }), settingsController.save);
app.get('/account', (req, res) => { res.status(200).send('account'); });
export const page = () => `<form method="post" action="/account/settings"><button>Save</button></form>`;
