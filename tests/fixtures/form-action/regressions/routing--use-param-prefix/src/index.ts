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
// Every org-scoped page requires an SSO session; bounce to the IdP otherwise.
function requireOrgSession(req: any, res: any, next: any) {
  if (!req.session?.orgUser) return res.redirect(303, `https://sso.example.com/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}
app.use('/org/:orgId', requireOrgSession);
app.post('/org/:orgId/billing', express.urlencoded({ extended: false }), (req, res) => { res.status(200).send('saved'); });
