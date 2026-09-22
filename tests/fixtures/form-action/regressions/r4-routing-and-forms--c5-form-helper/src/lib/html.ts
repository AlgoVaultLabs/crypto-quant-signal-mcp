export function postButton(action: string, label: string): string {
  return `<form method="post" action="${action}"><button type="submit">${label}</button></form>`;
}
