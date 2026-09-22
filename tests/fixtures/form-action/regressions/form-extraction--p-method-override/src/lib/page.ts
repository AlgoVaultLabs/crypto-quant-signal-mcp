export function page(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form action="/subscription?_method=DELETE" method="post">
  <button type="submit">Cancel subscription</button>
</form>`;
}
