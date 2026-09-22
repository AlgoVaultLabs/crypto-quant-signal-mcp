import fs from 'node:fs';
import path from 'node:path';
export function page(): string {
  return `<form action="/good" method="post"><button>Save</button></form>`;
}
export const billingTemplate = fs.readFileSync(path.join(__dirname, 'billing.html'), 'utf8');
