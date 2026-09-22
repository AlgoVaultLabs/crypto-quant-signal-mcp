export function billingForm(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form action="/billing">
  <select name="plan"><option>pro</option></select>
  <button type="submit">Preview price</button>
  <button type="submit" formmethod="post">Open billing portal</button>
</form>`;
}
