import type { Response } from 'express';
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } as const;
export function sendHtml(res: Response, html: string, status: number): void {
  res.status(status).set({ ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }).send(html);
}
