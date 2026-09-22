import type { Request, Response } from 'express';
async function save(req: Request, res: Response): Promise<void> {
  res.redirect(303, '/account?saved=1');
}
async function reset(req: Request, res: Response): Promise<void> {
  res.redirect(303, '/account?reset=1');
}
export default { save, reset };
