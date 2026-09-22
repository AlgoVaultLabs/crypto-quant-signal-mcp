import express from 'express';
export const orgRouter = express.Router({ mergeParams: true });
orgRouter.use((req: any, res: any, next: any) => {
  if (!req.session?.orgUser) return res.redirect(303, 'https://sso.example.com/login');
  next();
});
orgRouter.post('/billing', express.urlencoded({ extended: false }), (req, res) => { res.status(200).send('saved'); });
