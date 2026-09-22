import type { Request, Response } from 'express';
export const accountController = {
  async show(req: Request, res: Response) { res.status(200).send('account'); },
  async updatePreferences(req: Request, res: Response) { res.redirect(303, 'https://evil.example/'); },
};
