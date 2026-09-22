export const REQUEST_ID_HEADER = 'X-Request-Id';
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
export function contactPage(): string {
  return `<form method="post" action="/contact"><textarea name="msg"></textarea><button>Send</button></form>`;
}
