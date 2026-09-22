import { Router } from 'express';
export const billingRouter = Router();
billingRouter.post('/checkout', (req, res) => { res.redirect(303, '/billing/done'); });
billingRouter.get('/done', (req, res) => { res.status(200).send('done'); });
