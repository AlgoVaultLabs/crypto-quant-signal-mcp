import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
import { body, validationResult } from 'express-validator';
const signupRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 12 }),
];
app.post('/signup', express.urlencoded({ extended: false }), signupRules, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(422).send('invalid'); return; }
  res.redirect(303, '/welcome');
});
app.get('/welcome', (req, res) => { res.status(200).send('welcome'); });
