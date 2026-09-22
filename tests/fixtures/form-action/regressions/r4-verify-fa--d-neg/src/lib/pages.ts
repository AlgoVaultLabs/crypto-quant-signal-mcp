export function prefsHtml(): string {
  return `<form method="post" action="/account/preferences"><input name="theme"><button>Save</button></form>`;
}
