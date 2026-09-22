export async function contactHandler(req: any, res: any): Promise<void> {
  res.redirect(303, '/contact?sent=1');
}
