const styles = `*{box-sizing:border-box}body{margin:0;color:#202124;background:#fff;font:16px/1.7 Arial,system-ui,sans-serif}main{max-width:760px;margin:64px auto;padding:0 24px}a{color:inherit;text-underline-offset:3px}.brand{font-size:21px;font-weight:750;text-decoration:none}h1{font-size:32px;letter-spacing:-1px;margin-top:50px}h2{font-size:20px;margin-top:30px}.muted{color:#717171}footer{border-top:1px solid #eee;margin-top:48px;padding:24px 0;display:flex;gap:24px}li{margin-bottom:8px}`;

const privacy = `<h1>Privacy at Outpredict</h1><p class="muted">Updated September 9, 2026</p>
<p>Outpredict provides free medical-school admissions guidance. This page explains how the application handles your information.</p>
<h2>Your account and conversations</h2><p>Google sign-in provides your basic account identity: name, email, and profile image. Outpredict uses Google’s openid, email, and profile scopes. It stores account records and sessions to keep you signed in. It does not request access to your Google Drive, Gmail, or other Google content.</p>
<p>Your questions, answers, evidence, and uploaded files are stored with your account. Uploaded originals are held in private storage. Only your authenticated account can access its conversations and files through the application.</p>
<h2>How answers are generated</h2><p>Cloudflare hosts the application and its databases and file storage. When you ask a question, Cloudflare Workers AI processes the conversation and any relevant extracted document content to generate an answer. Cloudflare also extracts text from supported uploads. Avoid uploading information you do not have permission to share.</p>
<p>Admissions evidence comes from the imported, reviewed student-profile corpus and information you provide. Outpredict does not run external web searches or retrieve outside webpages during conversations. Public applicant profiles are a separate dataset; your uploaded documents are not added to it.</p>
<h2>Control and deletion</h2><p>You can delete individual uploaded files and conversations from the application. Removing a file removes its original and extracted text from active application storage. Deleting a conversation removes its saved messages and associated files. Information already included in an answer remains part of that conversation until you delete it. Signing out ends your current session; it does not delete saved conversations.</p>
<p>Account records remain until account removal is requested. For account removal or privacy questions, contact <a href="mailto:avneesh.muralitharan@gmail.com">avneesh.muralitharan@gmail.com</a>. Service-provider backups and operational records may have separate retention periods.</p>
<h2>Operations</h2><p>Outpredict records technical error categories and usage counts to maintain the service and enforce reasonable limits. Application logs are designed to exclude question text, document content, and credentials. Authentication cookies are used to maintain your session.</p>`;

const terms = `<h1>Using Outpredict</h1><p class="muted">Updated September 9, 2026</p>
<p>Outpredict is a free tool for exploring medical-school admissions questions. You remain responsible for the decisions you make and the application materials you submit.</p>
<h2>Evidence and limitations</h2><p>Public applicant profiles are self-reported and may be incomplete or inaccurate. They are a small convenience sample, not a representative national dataset. Reported outcomes apply to the stated school and cycle. An answer does not establish your admission probability or guarantee any outcome.</p>
<p>AI-generated answers can contain errors. Check cited sources and confirm requirements and deadlines with the school or application service before acting.</p>
<h2>Your materials</h2><p>Upload only materials you have permission to use. You retain ownership of your materials. Outpredict processes them to provide the requested guidance, as described in the <a href="/privacy">privacy policy</a>. Do not submit fabricated credentials or use the service to impersonate another applicant.</p>
<h2>Availability and fair use</h2><p>The service has reasonable message, file-size, and storage limits. Features and availability may change as the product develops. Do not attempt to access another person’s account, disrupt the service, or bypass its usage controls.</p>
<p>Questions: <a href="mailto:avneesh.muralitharan@gmail.com">avneesh.muralitharan@gmail.com</a>.</p>`;

export function publicPage(path: string): Response | null {
  const body = path === "/privacy" ? privacy : path === "/terms" ? terms : null;
  if (!body) return null;
  const title = path === "/privacy" ? "Privacy" : "Using Outpredict";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Outpredict</title><style>${styles}</style></head><body><main><a class="brand" href="/">outpredict</a>${body}<footer><a href="/">Back to Outpredict</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
