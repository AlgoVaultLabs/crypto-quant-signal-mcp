import { Router } from 'express';
const router = Router();
router.post('/checkout', (req, res) => { res.redirect(303, '/billing/done'); });
router.get('/done', (req, res) => { res.status(200).send('done'); });
export default router;
