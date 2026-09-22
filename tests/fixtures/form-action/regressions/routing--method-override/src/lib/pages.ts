export function accountHtml(): string {
  return `<form method="post" action="/account"><input name="email"><button>Save</button></form>
<form method="post" action="/account"><input type="hidden" name="_method" value="DELETE"><button>Delete my account</button></form>`;
}
