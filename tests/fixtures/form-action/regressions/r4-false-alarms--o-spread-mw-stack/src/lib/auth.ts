import type { Request, Response, NextFunction } from 'express';
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).session?.userId) { res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`); return; }
  next();
}
