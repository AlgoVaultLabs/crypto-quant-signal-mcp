import type { Request, Response } from 'express';
export const accountController = {
  async cancel(req: Request, res: Response) { res.redirect(303, '/account?cancelled=1'); },
  async show(req: Request, res: Response) { res.status(200).send('account'); },
};
