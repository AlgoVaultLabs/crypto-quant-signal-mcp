export function page(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form action="/upgrade"><input type="hidden" name="plan" value="pro"><button>Upgrade</button></form>`;
}
