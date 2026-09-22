// Fixture (FAIL): same-origin form POST -> handler redirects to a non-literal, cross-origin URL.
export function payPageHtml(): string {
  return `<form class="panel" action="/pay" method="post"><button>Pay</button></form>`;
}
export async function payHandler(req: any, res: any): Promise<void> {
  const portalUrl = await mintSession();
  res.redirect(303, portalUrl);
}
async function mintSession(): Promise<string> { return 'https://billing.example.com/session'; }
