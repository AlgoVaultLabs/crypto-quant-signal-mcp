// Fixture (FAIL matrix): every handler here can emit a cross-origin Location after a form POST.
const asyncHandler = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
async function mint(x?: string): Promise<string> { return 'https://billing.example.com/session/' + (x ?? ''); }
function portalUrl(r: any): string { return 'https://billing.example.com/p/' + String(r.body?.id); }
export function externalUrl(): string { return 'https://billing.example.com/x'; }
export function mintCheckout(): string { return 'https://checkout.stripe.com/c/pay'; }
export async function absLiteral(req: any, res: any): Promise<void> { res.redirect(303, 'https://billing.stripe.com/p/session'); }
export async function locationH(req: any, res: any): Promise<void> { const u = await mint(); res.status(303).location(u).end(); }
export async function setHeaderH(req: any, res: any): Promise<void> { const next = await mint(); res.statusCode = 302; res.setHeader('Location', next); res.end(); }
export async function writeHeadH(req: any, res: any): Promise<void> { const next = await mint(); res.writeHead(303, { Location: next }); res.end(); }
export async function setObjectH(req: any, res: any): Promise<void> { const x = await mint(); res.status(303).set({ Location: x }).end(); }
export const wrappedHandler = asyncHandler(async (req: any, res: any) => { const portal = await mint(); res.redirect(303, portal); });
export async function retTypeHandler(req: any, res: any): Promise<{ redirected: boolean }> { const u = await mint(); res.redirect(303, u); return { redirected: true }; }
export const conciseHandler = (req: any, res: any) => res.redirect(303, portalUrl(req));
export async function nextHandler(req: any, res: any): Promise<void> { const u = await mint(); res.redirect(303, u); }
export async function okHandler(req: any, res: any): Promise<void> { res.status(200).send('ok'); }
export async function regexHandler(req: any, res: any): Promise<void> {
  const name = String(req.body?.name ?? '').replace(/'/g, '&#39;').replace(/[&<>"']/g, (c: string) => c);
  const next = typeof req.body?.next === 'string' ? req.body.next : '';
  const safe = (!next.startsWith('/') || next.startsWith('//')) ? '/account' : next;
  if (/^\/\//.test(next) || next === '/api/*') { res.status(400).send(name); return; }
  const portalUrl = await mint(safe);
  res.redirect(303, portalUrl);
}
export async function apxHandler(req: any, res: any): Promise<void> { res.redirect(303, 'https://api.algovault.com/done'); }
