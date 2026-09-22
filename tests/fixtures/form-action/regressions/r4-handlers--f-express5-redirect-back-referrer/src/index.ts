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
app.get('/account/settings', (req, res) => { res.status(200).send('settings'); });
// Express 5 removed the 'back' magic string; its migration guide's replacement:
app.post('/account/settings', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  if (!req.body?.tz) return res.redirect(303, req.get('Referrer') || '/');
  res.redirect(303, '/account/settings?saved=1');
});
app.post('/account/tz', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  res.redirect('back');
});
export const page = () => `<form method="post" action="/account/settings"><input name="tz"><button>Save</button></form>
<form method="post" action="/account/tz"><input name="tz"><button>Save (express 4)</button></form>`;
