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
app.use((req: Request, res: Response, next: NextFunction) => {
  (res as any).seeOther = function (this: Response, url: string) { this.redirect(303, url); };
  next();
});
app.post('/account/portal', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  (res as any).seeOther(`https://billing.stripe.com/p/session/${req.body.customer}`);
});
export const page = () => `<form method="post" action="/account/portal"><button>Manage billing</button></form>`;
