export function accountPage(): string {
  return `<form action="/good" method="post">
  <form-field label="Email"><input name="email"></form-field>
  <button type="submit">Save</button>
  <button type="submit" formaction="/billing/portal">Manage billing</button>
</form>`;
}
