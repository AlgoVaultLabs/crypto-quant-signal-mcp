export function contactPage(): string {
  return `<form method="post" action="/contact"><textarea name="msg"></textarea><button>Send</button></form>`;
}
