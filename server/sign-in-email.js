/** Self-contained HTML: inline styles and layout tables work in Gmail, Apple Mail and Outlook. */
export function signInEmail(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit sign-in code is required');
  return {
    subject: 'Your Learn4Life sign-in code',
    text: `Your sign-in code is ${code}. It expires in 10 minutes and can be used once.\n\nEnter this code on the Learn4Life Fleet sign-in screen to continue.\nhttps://fleetcheckout.app\n\nKeep this code private. If you did not request it, ignore this email.\n\nLearn4Life Fleet | Vehicle checkout & returns`,
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Your Learn4Life sign-in code</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f2;color:#243b33;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;color:#f3f5f2;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Your one-time code is ready. Enter it to access Learn4Life Fleet. Valid for 10 minutes.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f3f5f2;">
    <tr><td align="center" style="padding:40px 16px;">
      <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #dce2d9;border-radius:12px;border-top:5px solid #126b61;">
        <tr><td style="padding:32px 32px 28px;border-bottom:1px solid #e9ede7;">
          <p style="margin:0;font-size:25px;font-weight:700;letter-spacing:-0.8px;line-height:32px;color:#243b33;">Learn<span style="color:#126b61;">4</span>Life <span style="font-weight:400;color:#69766e;">Fleet</span></p>
          <p style="margin:5px 0 0;font-size:12px;line-height:18px;color:#69766e;">VEHICLE CHECKOUT &amp; RETURNS</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:26px;line-height:34px;letter-spacing:-0.5px;font-weight:700;color:#243b33;">Your sign-in code</h1>
          <p style="margin:0 0 26px;font-size:16px;line-height:25px;color:#58685f;">Enter the code below on your sign-in screen to access Learn4Life Fleet.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#eef5f1;border:1px solid #d4e5dc;border-radius:8px;">
            <tr><td align="center" style="padding:24px 12px;">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;line-height:16px;color:#426257;">ONE-TIME SIGN-IN CODE</p>
              <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:36px;line-height:46px;font-weight:700;letter-spacing:6px;color:#126b61;">${code}</p>
              <p style="margin:10px 0 0;font-size:13px;line-height:20px;color:#58685f;">Expires in <strong>10 minutes</strong> &middot; Use once</p>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:14px;line-height:22px;color:#58685f;">Keep this code private. If you didn&rsquo;t request it, you can safely ignore this email.</p>
          <p style="margin:24px 0 0;font-size:14px;line-height:22px;"><a href="https://fleetcheckout.app" style="color:#126b61;font-weight:700;text-decoration:underline;text-underline-offset:3px;">Open Learn4Life Fleet &rarr;</a></p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
      <p style="margin:22px 0 0;font-size:12px;line-height:20px;color:#69766e;">Learn4Life Fleet<br><a href="https://fleetcheckout.app" style="color:#69766e;text-decoration:none;">fleetcheckout.app</a></p>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
