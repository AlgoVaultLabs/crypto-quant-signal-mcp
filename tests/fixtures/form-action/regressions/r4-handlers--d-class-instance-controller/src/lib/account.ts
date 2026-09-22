import type { Request, Response } from 'express';
export class AccountController {
  save = async (req: Request, res: Response): Promise<void> => {
    res.redirect(303, '/account?saved=1');
  };
  profile = async (req: Request, res: Response): Promise<void> => {
    res.redirect(303, '/account?profile=1');
  };
}
export const accountController = new AccountController();
export function accountPage(): string {
  return `<form method="post" action="/account/settings"><button>Save</button></form>
<form method="post" action="/account/profile"><button>Save profile</button></form>`;
}
