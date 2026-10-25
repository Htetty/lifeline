const phone = /^\+[1-9]\d{6,14}$/;

export function configuration(env = process.env) {
  const projectId = env.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = env.SPECTRUM_PROJECT_SECRET?.trim();
  const line = env.SPECTRUM_LINE_NUMBER?.trim();
  const senders = (env.SPECTRUM_ALLOWED_SENDERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const missing = [
    ["SPECTRUM_PROJECT_ID", projectId],
    ["SPECTRUM_PROJECT_SECRET", projectSecret],
    ["SPECTRUM_LINE_NUMBER", line],
    ["SPECTRUM_ALLOWED_SENDERS", senders.length],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Set ${missing.join(", ")} in integrations/photon/.env (see .env.example).`);
  if (projectId.startsWith("pho_prj_") || projectSecret.startsWith("pho_sk_") || projectSecret.startsWith("pho_ask_")) {
    throw new Error("Use Stable Spectrum credentials from app.photon.codes. Beta project IDs and API keys belong to a separate API.");
  }
  if (!phone.test(line) || senders.some(sender => !phone.test(sender))) {
    throw new Error("Use E.164 numbers (+countrycode and digits) for the line and allowed senders.");
  }
  return { projectId, projectSecret, line, allowedSenders: new Set(senders) };
}
