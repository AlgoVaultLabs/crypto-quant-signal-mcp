export function accountPage(isPaid: boolean): string {
  let html = '<form action="/good" method="post"><input name="email"><button type="submit">Save</button>';
  if (isPaid) html += '<button type="submit" formaction="/billing/portal">Manage billing</button>';
  html += '</form>';
  return html;
}
