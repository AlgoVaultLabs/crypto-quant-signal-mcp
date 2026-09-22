// Fixture (INDETERMINATE): a registration whose path the gate cannot place (a parameter) could serve
// ANY path, so neither an unrouted own-origin hop nor an unrouted GET form may read as terminal.
import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
export function mountDynamic(path: string): void {
  app.get(path, (req, res) => { res.redirect(303, 'https://billing.stripe.com/p/session'); });
}
app.post('/u/save', express.urlencoded({ extended: false }), (req, res) => { res.redirect(303, '/u/elsewhere'); });
