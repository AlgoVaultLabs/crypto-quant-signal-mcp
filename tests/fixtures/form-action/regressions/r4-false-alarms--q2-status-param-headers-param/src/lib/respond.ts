import type { Response } from 'express';
export function sendHtml(res: Response, html: string, status: number, headers: Record<string, string>): void {
  res.status(status).set(headers).send(html);
}
