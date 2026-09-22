// A higher-order guard: the RETURNED function is what Express runs, and it is what redirects.
const LOGIN_URL = 'https://accounts.example-idp.com/sign-in';
export function withSession(fn: (req: any, res: any) => Promise<void>) {
  return async (req: any, res: any, next: any) => {
    if (!req.headers.cookie) return res.redirect(303, LOGIN_URL);
    try { await fn(req, res); } catch (e) { next(e); }
  };
}
export function checkoutPage(): string {
  return `<form method="post" action="/checkout"><button>Buy</button></form>`;
}
