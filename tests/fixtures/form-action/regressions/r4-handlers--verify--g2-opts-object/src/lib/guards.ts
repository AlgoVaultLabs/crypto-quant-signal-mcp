import type { Request, Response, NextFunction } from 'express';
export function requireLogin(opts: { redirectTo: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.cookie) return res.redirect(303, opts.redirectTo);
    next();
  };
}
export const validateBody = (fields: string[]) => (req: Request, res: Response, next: NextFunction) => { next(); };
