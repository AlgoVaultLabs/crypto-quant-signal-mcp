export function accountPage(isPaid: boolean): string {
  return `<form action="/good" method="post">
  <input name="email">
  <button type="submit" formaction="/billing/portal">Manage billing</button>
</form>`;
}
