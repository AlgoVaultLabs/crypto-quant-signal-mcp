const METHOD = 'post';
export function billingForm(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<form method="${METHOD}" action="/billing/portal"><button>Manage billing</button></form>`;
}
