function sendTo(res: any, to: string, host?: string): void {
  if (host) to = `https://${host}${to}`;
  res.redirect(303, to);
}
export function h(req: any, res: any): void { sendTo(res, '/done', req.body?.host); }
export const page = () => `<form action="/go" method="post"></form>`;
