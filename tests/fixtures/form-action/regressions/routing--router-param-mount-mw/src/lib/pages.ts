export function orgHtml(org: string): string {
  return `<form method="post" action="/org/${encodeURIComponent(org)}/billing"><button>Save</button></form>`;
}
