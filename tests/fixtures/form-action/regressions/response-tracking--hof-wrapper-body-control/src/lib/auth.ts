const LOGIN_URL = 'https://accounts.example-idp.com/sign-in';
export const requireSession = (req: any, res: any, next: any) => { if (!req.headers.cookie) return res.redirect(303, LOGIN_URL); next(); };
export function checkoutPage(): string {
  return `<form method="post" action="/checkout"><button>Buy</button></form>`;
}
