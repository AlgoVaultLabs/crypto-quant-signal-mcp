import type { Request, Response } from 'express';
export async function show(req: Request, res: Response) { res.status(200).send('account'); }
export async function updatePreferences(req: Request, res: Response) { res.redirect(303, '/account?saved=1'); }
