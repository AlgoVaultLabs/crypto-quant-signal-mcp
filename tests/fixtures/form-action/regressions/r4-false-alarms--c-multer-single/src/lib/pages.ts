export function avatarHtml(): string {
  return `<form method="post" action="/account/avatar" enctype="multipart/form-data"><input type="file" name="avatar"><button>Upload</button></form>`;
}
