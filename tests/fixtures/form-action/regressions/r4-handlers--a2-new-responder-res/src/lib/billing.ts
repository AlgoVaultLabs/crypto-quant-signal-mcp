import type { Response } from 'express';
export class Responder {
  constructor(private readonly res: Response) {}
  seeOther(url: string): void { this.res.redirect(303, url); }
}
export function accountPage(): string {
  return `<form method="post" action="/account/portal"><button>Manage billing</button></form>`;
}
