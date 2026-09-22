export async function listTrades(): Promise<Array<Record<string, string>>> { return [{ a: '1' }]; }
export const exportHtml = () => `<form method="post" action="/export"><button>Download CSV</button></form>`;
