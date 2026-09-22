import express, { Router } from 'express';
const router = Router();
router.post('/preferences', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/account?saved=1'); });
router.get('/', (req, res) => { res.status(200).send('account'); });
export default router;
