export function accountPage(): string {
  return `<form id="acct" action="/good" method="post">
  <input name="email">
</form>
<div class="actions">
  <button type="submit" form="acct">Save</button>
  <button type="submit" form="acct" formaction="/billing/portal">Manage billing</button>
</div>`;
}
