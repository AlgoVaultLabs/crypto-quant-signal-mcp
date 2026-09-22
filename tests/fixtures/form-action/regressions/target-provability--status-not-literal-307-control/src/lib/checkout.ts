async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_fixture_x'; }
export function checkoutGet(req: any, res: any): void { res.status(200).send('<p>choose a plan</p>'); }
export async function checkoutPost(req: any, res: any): Promise<void> { res.redirect(303, await mintCheckout()); }
export const page = () => `<form action="/pay/legacy" method="post"></form>
<form action="/pay/old" method="post"></form>
<form action="/pay/raw" method="post"></form>
<form action="/pay/split" method="post"></form>`;
