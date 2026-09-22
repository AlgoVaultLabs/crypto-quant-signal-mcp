export function redirectTo(res: any, url: string): void { res.redirect(303, url); }
export async function createPortalSession(customer: string): Promise<{ url: string }> { return { url: 'https://billing.stripe.com/p/session/' + customer }; }
export function accountPage(): string { return `<form method="post" action="/account/portal"><button>Manage billing</button></form>`; }
