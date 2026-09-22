import type { Request, Response } from 'express';
export async function cancel(req: Request, res: Response) { res.redirect(303, '/account?cancelled=1'); }
export async function show(req: Request, res: Response) { res.status(200).send('account'); }
