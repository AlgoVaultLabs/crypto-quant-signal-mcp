export function pricingPage(): string {
  return `<form method="get" action="/billing/checkout"><input type="hidden" name="plan" value="pro"><button>Buy Pro</button></form>`;
}
