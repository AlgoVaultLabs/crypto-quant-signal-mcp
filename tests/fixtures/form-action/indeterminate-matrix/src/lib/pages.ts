// Fixture (INDETERMINATE matrix): one form per per-form reason, plus one verified form.
import { API_BASE } from './config.js';
export function pages(): string {
  return `<form action="/i/nowhere" method="post"></form>
<form method="post"></form>
<form action="${API_BASE}/x" method="post"></form>
<form action="relative/path" method="post"></form>
<form action="/i/ghost" method="post"></form>
<form action="/i/ok" method="post"></form>
<form action="https://algovault.com/i/api-only" method="post"></form>`;
}
export const broken = '<form action="/i/half" method="post"';
export function attrsPage(attrs: string): string {
  return `<form ${attrs}></form>`;
}
