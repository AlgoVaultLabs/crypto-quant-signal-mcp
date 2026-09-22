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
const PORTAL = '\\\\billing.stripe.com/p/login/abc';
app.post('/bs/double', (req, res) => { res.redirect(303, '\\\\billing.stripe.com/p/login/abc'); });
app.post('/bs/slash', (req, res) => { res.redirect(303, '\\/billing.stripe.com/p/login/abc'); });
app.post('/bs/const', (req, res) => { res.redirect(303, PORTAL); });
app.post('/ws/tab', (req, res) => { res.statusCode = 303; res.setHeader('Location', '/\t/billing.stripe.com/p/login/abc'); res.end(); });
app.post('/ws/space', (req, res) => { res.writeHead(303, { Location: ' //billing.stripe.com/p/login/abc' }); res.end(); });
app.post('/ws/tab-tpl', (req, res) => { const id = String(req.body?.id ?? ''); res.set('Location', `/\t/billing.stripe.com/p/${id}`); res.status(303).end(); });
