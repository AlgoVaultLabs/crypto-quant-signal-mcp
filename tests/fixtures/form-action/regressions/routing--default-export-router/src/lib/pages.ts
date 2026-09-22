export function pricingHtml(): string {
  return `<form method="post" action="/subscribe"><button>Subscribe</button></form>
<form method="get" action="/checkout/start"><button>Checkout</button></form>`;
}
