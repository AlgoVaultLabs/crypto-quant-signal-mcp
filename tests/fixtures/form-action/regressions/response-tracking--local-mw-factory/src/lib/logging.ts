export function requestLogger(opts: { level: string }) {
  return (req: any, res: any, next: any) => {
    const t0 = Date.now();
    res.on('finish', () => console.log(opts.level, req.method, req.url, res.statusCode, Date.now() - t0));
    next();
  };
}
export function contactPage(): string {
  return `<form method="post" action="/contact"><textarea name="msg"></textarea><button>Send</button></form>`;
}
