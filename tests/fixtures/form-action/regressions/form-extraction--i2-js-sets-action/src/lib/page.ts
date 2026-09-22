export function accountPage(): string {
  return `<form id="acct" action="/good" method="post">
  <select id="intent" name="intent"><option value="save">Save</option><option value="billing">Manage billing</option></select>
  <button type="submit">Continue</button>
</form>
<script>
  document.getElementById('intent').addEventListener('change', function (e) {
    document.getElementById('acct').action = e.target.value === 'billing' ? '/billing/portal' : '/good';
  });
</script>`;
}
