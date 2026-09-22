// Fixture (FAIL matrix, round-2 shapes): shadowing, destructuring and helpers that receive the response.
const url = '/account?saved=1';
const target = '/account';
async function mint(): Promise<string> { return 'https://billing.example.com/s'; }
async function session(): Promise<{ url: string }> { return { url: 'https://billing.stripe.com/p/session' }; }
function go(out: any, dest: string): void { out.redirect(303, dest); }
export const shadowHandler = async (req: any, res: any) => { const { url } = await session(); res.redirect(303, url); };
export const paramShadowHandler = (req: any, res: any) => { mint().then((target: string) => res.redirect(303, target)); };
export async function helperHandler(req: any, res: any): Promise<void> { const u = await mint(); go(res, u); }
export const unused = [url, target];
