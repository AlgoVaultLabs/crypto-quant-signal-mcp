import type { Response } from 'express';
export function sendHtml(res: Response, html: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
