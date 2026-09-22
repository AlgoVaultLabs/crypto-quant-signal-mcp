export async function createCheckoutSession(plan: string): Promise<{ url: string }> {
  return { url: `https://checkout.stripe.com/c/pay/${plan}` };
}
export function pricingPage(): string {
  return `<form method="post" action="/buy"><input name="plan" value="pro"><button>Buy</button></form>`;
}
