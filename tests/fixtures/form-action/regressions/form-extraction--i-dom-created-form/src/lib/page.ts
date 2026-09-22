export function accountPage(): string {
  return `<form action="/good" method="post"><button>Save</button></form>
<button type="button" id="manage">Manage billing</button>
<script>
  document.getElementById('manage').addEventListener('click', function () {
    var f = document.createElement('form');
    f.method = 'post';
    f.action = '/billing/portal';
    document.body.appendChild(f);
    f.submit();
  });
</script>`;
}
