export function page(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form action="/billing/portal" method="post"><button>Manage billing</button></form>`;
}
