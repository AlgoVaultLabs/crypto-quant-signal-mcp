export function planPage(plan: string): string {
  return `<form method="post" action="/subscribe/${encodeURIComponent(plan)}"><button>Subscribe</button></form>`;
}
