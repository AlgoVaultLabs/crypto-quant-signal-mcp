import { Router } from 'express';
export const accountRouter = Router();
accountRouter.post('/portal', (req: any, res: any) => { res.redirect(303, 'https://billing.stripe.com/p/session'); });
