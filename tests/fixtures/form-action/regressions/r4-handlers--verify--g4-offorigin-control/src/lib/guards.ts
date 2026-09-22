import type { Request, Response, NextFunction } from 'express';
export function requireLogin(loginPath = '/account/login') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.cookie) return res.redirect(303, loginPath);
    next();
  };
}
export const validateBody = (fields: string[], onError: string) => (req: Request, res: Response, next: NextFunction) => {
  if (fields.some((f) => !req.body?.[f])) return res.redirect(303, onError);
  next();
};
