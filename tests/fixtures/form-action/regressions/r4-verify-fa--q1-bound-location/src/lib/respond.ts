import type { Response } from 'express';
export function sendHtml(res: Response, html: string, status = 200): void {
  res.status(status).set({ ...{ 'X-A': 'b' }, 'Content-Type': 'text/html; charset=utf-8' }).send(html);
}
