// Fixture (PASS matrix): one form per correct shape.
export function pages(token: string): string {
  return `<form action="/p/rel" method="post"></form>
<form action="/p/tpl" method="post"></form>
<form action="/p/concat" method="post"></form>
<form action="/p/ternary" method="post"></form>
<form action="/p/api-abs" method="post"></form>
<form action="/p/regex" method="post"></form>
<form action="/p/back" method="post"></form>
<form action="/p/handoff" method="post"></form>
<form METHOD="POST" action="/p/upper"></form>
<form method="post" action="/email/unsubscribe/${encodeURIComponent(token)}"></form>
<form action="/p/decoy" method="post"></form>
<form action="/p/json301" method="post"></form>
<form action="/p/hop" method="post"></form>
<form action="/p/writehead-rel" method="post"></form>
<form action="/verify" method="get" onsubmit="return false"></form>
<form class="js-only" novalidate></form>
<!-- <form action="/p/commented" method="post"></form> -->
<form method="dialog"></form>
<form action="/p/local-const" method="post"></form>
<form action="/p/const-tpl" method="post"></form>
<form action="/p/helper-ok" method="post"></form>
<form action="/p/rate" method="post"></form>
<form action="/p/limiter-local" method="post"></form>
<form action="/p/prg" method="post"></form>`;
}
// A `+` chain with several template parts must yield exactly ONE form (it was once rendered per part).
export function chained(a: string, b: string): string {
  return '<section>' + `<form action="/p/chain" method="post">` + `<input name="${a}">` +
    `<input name="${b}"></form>` + '</section>';
}
export function attrInertPage(opts: { source?: string; ref?: string }, esc: (s: string) => string): string {
  const dataSource = ` data-source="${esc(opts.source ?? 'x')}"`;
  const dataRef = opts.ref ? ` data-ref="${esc(opts.ref)}"` : '';
  return `<form id="p-attr"${dataSource}${dataRef} data-prefix="${esc('y')}"></form>`;
}
