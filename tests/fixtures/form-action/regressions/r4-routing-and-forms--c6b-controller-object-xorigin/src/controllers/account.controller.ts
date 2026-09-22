import type { Request, Response } from 'express';
export const accountController = {
  async cancel(req: Request, res: Response) { res.redirect(303, 'https://billing.stripe.com/p/session'); },
  async show(req: Request, res: Response) { res.status(200).send('account'); },
};
