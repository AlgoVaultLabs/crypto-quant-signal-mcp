import type { Request, Response } from 'express';
class AccountController {
  cancel = async (req: Request, res: Response) => { res.redirect(303, '/account?cancelled=1'); };
  show = async (req: Request, res: Response) => { res.status(200).send('account'); };
}
export const accountController = new AccountController();
