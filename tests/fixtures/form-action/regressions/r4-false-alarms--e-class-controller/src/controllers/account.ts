import type { Request, Response } from 'express';
export class AccountController {
  async show(req: Request, res: Response): Promise<void> { res.status(200).send('account'); }
  async updatePreferences(req: Request, res: Response): Promise<void> { res.redirect(303, '/account?saved=1'); }
}
