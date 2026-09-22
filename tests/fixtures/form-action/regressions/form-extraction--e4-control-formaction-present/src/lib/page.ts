export function confirmDialog(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<dialog id="confirm-portal">
  <form method="dialog" action="/billing/portal">
    <p>Leave for the Stripe billing portal?</p>
    <button value="cancel">Cancel</button>
    <button formmethod="post" formaction="/billing/portal">Continue to billing</button>
  </form>
</dialog>`;
}
