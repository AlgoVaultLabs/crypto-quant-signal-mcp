import type { Request, Response } from 'express';
export class AccountController {
  async save(req: Request, res: Response): Promise<void> {
    res.redirect(303, '/account?saved=1');
  }
}
export function accountPage(): string {
  return `<form method="post" action="/account/settings"><button>Save</button></form>`;
}
