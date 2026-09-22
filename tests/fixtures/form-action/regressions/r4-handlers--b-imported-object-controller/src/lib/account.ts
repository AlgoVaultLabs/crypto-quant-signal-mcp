import type { Request, Response } from 'express';
export const accountController = {
  async updateProfile(req: Request, res: Response): Promise<void> {
    res.redirect(303, '/account?profile=1');
  },
};
export function accountPage(): string {
  return `<form method="post" action="/account/profile"><button>Save profile</button></form>
<form method="post" action="/account/settings"><button>Save settings</button></form>`;
}
