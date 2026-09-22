export function accountPage(): string {
  const a = `<form action="/good" method="post"><button>Save</button></form>`;
  const b = [
    '<form',
    '  class="panel"',
    '  method="post"',
    '  action="/billing/portal">',
    '  <button type="submit">Manage billing</button>',
    '</form>',
  ].join('\n');
  return a + b;
}
