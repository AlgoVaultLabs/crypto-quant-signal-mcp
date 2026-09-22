import type { Request, Response } from 'express';
async function show(req: Request, res: Response) { res.status(200).send('account'); }
async function updatePreferences(req: Request, res: Response) { res.redirect(303, '/account?saved=1'); }
export default { show, updatePreferences };
