export function accountPage(): string {
  return [
    '<form action="/good" method="post">',
    '<input name="email">',
    '<button type="submit">Save</button>',
    '<button type="submit" formaction="/billing/portal">Manage billing</button>',
    '</form>',
  ].join('');
}
