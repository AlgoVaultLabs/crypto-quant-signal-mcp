import type { Response } from 'express';
export function redirectTo(res: Response, url: string): void { res.redirect(303, url); }
