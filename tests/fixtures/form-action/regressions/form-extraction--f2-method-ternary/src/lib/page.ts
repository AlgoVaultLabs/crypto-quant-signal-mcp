// One template for the plan picker: GET previews a price, POST opens the portal.
export function planForm(confirming: boolean): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form method="${confirming ? 'post' : 'get'}" action="/billing">
  <select name="plan"><option>pro</option></select>
  <button type="submit">${confirming ? 'Open billing portal' : 'Preview price'}</button>
</form>`;
}
