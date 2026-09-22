import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => { res.status(200).send('settings'); });
router.post('/', (req, res) => { res.redirect(303, `${req.baseUrl}?saved=1`); });
export default router;
