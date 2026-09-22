import { Router } from 'express';
const router = Router();
router.post('/delete', (req, res) => { res.status(200).send('deleted'); });
export default router;
