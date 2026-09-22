import type { Request, Response, NextFunction } from 'express';
export function requireLogin(role: string) {
  return (req: any, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return res.redirect(303, '/account/login');
    next();
  };
}
export const validateBody = (fields: string[]) => (req: Request, res: Response, next: NextFunction) => { next(); };
