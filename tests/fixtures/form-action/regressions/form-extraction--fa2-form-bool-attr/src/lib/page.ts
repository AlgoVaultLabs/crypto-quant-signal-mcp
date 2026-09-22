export function prefsPage(strict: boolean): string {
  return `<form action="/good" method="post" ${strict ? '' : 'novalidate'}>
  <input type="email" name="email" required>
  <button type="submit">Save</button>
</form>`;
}
