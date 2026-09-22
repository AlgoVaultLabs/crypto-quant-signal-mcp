export function prefsPage(optedIn: boolean, locked: boolean): string {
  return `<form action="/good" method="post">
  <label><input type="checkbox" name="optin" value="1"${optedIn ? ' checked' : ''}> Email me</label>
  <button type="submit"${locked ? ' disabled' : ''}>Save</button>
</form>`;
}
