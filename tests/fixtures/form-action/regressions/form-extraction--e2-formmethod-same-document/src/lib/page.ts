// Rendered by GET /billing: a GET filter form, plus a POST button that posts back to /billing.
export function billingPage(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form>
  <select name="plan"><option>pro</option></select>
  <button type="submit">Filter</button>
  <button type="submit" formmethod="post">Open billing portal</button>
</form>`;
}
