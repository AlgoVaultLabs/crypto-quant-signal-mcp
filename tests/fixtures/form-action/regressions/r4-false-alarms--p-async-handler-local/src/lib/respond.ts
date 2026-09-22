import type { Response } from 'express';
export function sendHtml(res: Response, html: string, status = 200, headers: Record<string, string> = {}): void {
  res.status(status);
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.send(html);
}
