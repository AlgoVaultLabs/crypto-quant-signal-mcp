import { Router } from 'express';
const router = Router();
router.post('/portal', (req: any, res: any) => { res.redirect(303, '/account?saved=1'); });
export default router;
