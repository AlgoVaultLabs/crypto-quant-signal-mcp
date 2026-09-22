import { Router } from 'express';
async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_2'; }
export const billing = Router();
billing.get('/checkout', async (req, res) => { res.redirect(303, await mintCheckout()); });
