const submitButton = (action: string, label: string): string =>
  `<button type="submit" formaction="${action}">${label}</button>`;
export function accountPage(): string {
  return `<form action="/good" method="post">
  <input name="email">
  <button type="submit">Save</button>
  ${submitButton('/billing/portal', 'Manage billing')}
</form>`;
}
