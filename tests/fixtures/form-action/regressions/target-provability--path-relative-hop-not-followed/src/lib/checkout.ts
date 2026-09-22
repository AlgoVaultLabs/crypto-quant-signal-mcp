export async function mintCheckout(): Promise<string> { return 'https://checkout.stripe.com/c/pay/cs_fixture_x'; }
export const page = () => `<form action="/checkout" method="post"></form>
<form action="/billing/start" method="post"></form>
<form action="/billing/start2" method="post"></form>`;
export const page2 = () => `<form action="/billing/start3" method="post"></form>
<form action="/billing/start4" method="post"></form>`;
