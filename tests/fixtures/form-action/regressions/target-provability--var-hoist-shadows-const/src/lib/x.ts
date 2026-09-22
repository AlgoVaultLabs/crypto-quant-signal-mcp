const url = '/account?saved=1';
async function portal(): Promise<string> { return 'https://billing.stripe.com/p/session/x'; }
export async function h(req: any, res: any): Promise<void> {
  try {
    var url = await portal();
  } catch {
    var url = '/account?portal=unavailable';
  }
  res.redirect(303, url);
}
export const page = () => `<form action="/account/save" method="post"></form>`;
export const home = url;
