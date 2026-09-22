export async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_fixture_x'; }
export const page = () => `<form action="/checkout" method="post"></form>
<form action="/billing/start" method="post"></form>
<form action="/billing/start2" method="post"></form>`;
