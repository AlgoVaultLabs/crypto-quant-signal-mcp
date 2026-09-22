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
import rateLimit from 'express-rate-limit';
import { regexOk, handoff, decoy } from './lib/handlers.js';
app.get('/p/done', (req, res) => { res.status(200).send('done'); });
app.post('/p/rel', (req, res) => { res.redirect(303, '/p/done'); });
app.post('/p/tpl', (req, res) => { const t = String(req.body?.t ?? ''); res.redirect(303, `/p/done?t=${encodeURIComponent(t)}`); });
app.post('/p/concat', (req, res) => { const k = String(req.body?.k ?? ''); res.redirect(303, '/p/done?k=' + encodeURIComponent(k)); });
app.post('/p/ternary', (req, res) => { res.redirect(303, req.body?.ok ? '/p/done' : '/p/retry'); });
app.post('/p/api-abs', (req, res) => { res.redirect(303, 'https://api.algovault.com/p/done'); });
app.post('/p/regex', regexOk);
app.post('/p/back', (req, res) => { res.redirect('back'); });
app.post('/p/handoff', handoff);
app.post('/p/upper', (req, res) => { res.status(200).send('ok'); });
app.post('/email/unsubscribe/:token', (req, res) => { res.status(200).send('ok'); });
app.post('/p/decoy', decoy);
app.post('/p/json301', (req, res) => { res.status(301).json({ moved: true, to: '/new' }); });
app.post('/p/hop', (req, res) => { res.redirect(303, '/p/landing'); });
app.get('/p/landing', (req, res) => { res.status(200).send('landed'); });
app.post('/p/writehead-rel', (req, res) => { res.writeHead(302, { Location: '/p/done' }); res.end(); });
app.post('/p/chain', (req, res) => { res.status(200).send('ok'); });
const NEXT = process.env.X ? '/p/done' : '/p/retry';
const limiter = rateLimit({ windowMs: 1000, max: 5 });
function sendTo(out: any, where: string): void { out.redirect(303, where); }
app.post('/p/const-tpl', (req, res) => { res.redirect(303, NEXT); });
app.post('/p/helper-ok', (req, res) => { sendTo(res, '/p/done'); });
app.post('/p/rate', limiter, (req, res) => { res.status(200).send('ok'); });
app.post('/p/prg', (req, res) => { res.redirect(303, '/account?saved=1'); });
export function main(): void {
  const saveHandler = async (req: any, res: any) => { res.redirect(303, '/p/done'); };
  const localLimiter = rateLimit({ windowMs: 1000, max: 5 });
  app.post('/p/local-const', express.urlencoded({ extended: false }), saveHandler);
  app.post('/p/limiter-local', localLimiter, (req, res) => { res.status(200).send('ok'); });
}
