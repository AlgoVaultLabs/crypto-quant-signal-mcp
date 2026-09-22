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
import { helperHandler, shadowHandler, paramShadowHandler } from './lib/more.js';
import { absLiteral, locationH, setHeaderH, writeHeadH, setObjectH, wrappedHandler, retTypeHandler, conciseHandler, nextHandler, okHandler, regexHandler, apxHandler, externalUrl, mintCheckout } from './lib/handlers.js';
app.post('/f/abs-literal', express.urlencoded({ extended: false }), absLiteral);
app.post('/f/location', locationH);
app.post('/f/setheader', setHeaderH);
app.post('/f/writehead', writeHeadH);
app.post('/f/set-object', setObjectH);
app.post('/f/wrapped', wrappedHandler);
app.post('/f/rettype', retTypeHandler);
app.post('/f/concise', conciseHandler);
app.post('/f/two-hop', (req, res) => { res.redirect(303, '/f/hop-target?plan=pro'); });
app.get('/f/hop-target', (req, res) => { const url = mintCheckout(); res.redirect(303, url); });
app.post('/f/next', (req, res, next) => { if (!req.body) { res.status(400).send('plan required'); return; } next(); });
app.post('/f/next', nextHandler);
app.post('/f/mw', (req, res, next) => { if (!req.body) return res.redirect(303, externalUrl()); next(); }, okHandler);
app.post('/f/regex', regexHandler);
app.post('/f/case', absLiteral);
app.post('/f/ok', okHandler);
app.post('/f/btn', absLiteral);
app.post('/f/unquoted', absLiteral);
app.post('/apx', apxHandler);
app.use('/f/use-prefix', (req, res, next) => { if (!req.headers.cookie) return res.redirect(303, 'https://login.example.com/'); next(); });
app.post('/f/use-prefix', okHandler);
app.post('/f/shadow', shadowHandler);
app.post('/f/param-shadow', paramShadowHandler);
app.post('/f/hop-apex', (req, res) => { res.redirect(303, '/f/hop-apex/thanks'); });
app.get('/f/hop-apex/thanks', (req, res) => { res.redirect(303, 'https://api.algovault.com/f/hop-apex/done'); });
app.get('/f/hop-apex/done', (req, res) => { res.status(200).send('done'); });
app.post('/f/helper', helperHandler);
app.route('/f/route-chain').all((req, res, next) => next()).post(nextHandler);
app.post('/f/slash-hole', (req, res) => { res.redirect(303, `/${String(req.body?.next ?? 'account')}`); });
app.post('/f/append', (req, res) => { res.status(303).append('Location', externalUrl()); res.end(); });
app.post('/f/writehead-var', (req, res) => { const headers = { Location: externalUrl() }; res.writeHead(303, headers); res.end(); });
app.post('/f/alias', (req, res) => { const r = res; r.redirect(303, externalUrl()); });
app.post('/f/bind', (req, res) => { const redirect = res.redirect.bind(res); redirect(303, externalUrl()); });
app.post('/f/elem', (req, res) => { res['redirect'](303, externalUrl()); });
app.post('/f/call', (req, res) => { res.redirect.call(res, 303, externalUrl()); });
app.post('/f/star-hop', (req, res) => { res.redirect(303, '/f/star/pro'); });
app.get('/f/star/*', (req, res) => { res.redirect(303, externalUrl()); });
app.post('/f/hole', okHandler);
app.post('/f/hole/portal', nextHandler);
app.post('/f/legacy-order', (req, res) => { res.redirect(externalUrl(), 301); });
app.post('/f/methods', (req, res) => { res.redirect(307, '/f/methods-next'); });
app.get('/f/methods-next', okHandler);
app.post('/f/methods-next', nextHandler);
export function main(): void {
  const requireSession = (req: any, res: any, next: any) => { if (!req.headers.cookie) return res.redirect(303, 'https://login.example.com/signin'); next(); };
  app.post('/f/mw-local', express.urlencoded({ extended: false }), requireSession, okHandler);
}
