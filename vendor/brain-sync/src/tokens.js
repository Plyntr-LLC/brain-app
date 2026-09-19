const encoder = new TextEncoder();

function toB64Url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64Url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

function keyBytes(secret) {
  return encoder.encode(String(secret || ""));
}

function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export async function signSeatToken(payload, secret) {
  const body = toB64Url(encoder.encode(JSON.stringify(payload)));
  const sig = toB64Url(await hmacSha256(keyBytes(secret), body));
  return `${body}.${sig}`;
}

export async function verifySeatToken(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  const expect = toB64Url(await hmacSha256(keyBytes(secret), body));
  if (expect.length !== sig.length) return { ok: false, reason: "bad sig" };
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: "bad sig" };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64Url(body)));
  } catch {
    return { ok: false, reason: "bad json" };
  }
  if (payload.exp && now / 1000 > payload.exp) return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}

export function issueSeatPayload({ seat, device_id, now = Date.now(), ttlSec = 30 * 24 * 3600 }) {
  const iat = Math.floor(now / 1000);
  return {
    seat_id: seat.seat_id,
    email: seat.email,
    hq_repo: seat.hq_repo,
    device_id,
    kind: seat.kind,
    iat,
    exp: iat + ttlSec,
  };
}

export async function importVerdictPrivateKey(pkcs8B64) {
  const raw = fromB64Url(pkcs8B64);
  return crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, true, ["sign"]);
}

export async function importVerdictPublicKey(spkiB64) {
  const raw = fromB64Url(spkiB64);
  return crypto.subtle.importKey("spki", raw, { name: "Ed25519" }, true, ["verify"]);
}

export async function generateVerdictKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = toB64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const spki = toB64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, pkcs8, spki };
}

export async function signVerdict(verdict, privateKey) {
  const body = encoder.encode(canonical(verdict));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, body);
  return { verdict, signature: toB64Url(new Uint8Array(sig)) };
}

export async function verifyVerdict(payload, publicKey, { nonce, now = Date.now(), skewSec = 300 } = {}) {
  if (!payload || !payload.verdict || !payload.signature) return { ok: false, reason: "missing" };
  const { verdict, signature } = payload;
  const body = encoder.encode(canonical(verdict));
  const sig = fromB64Url(signature);
  const good = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, sig, body);
  if (!good) return { ok: false, reason: "bad sig" };
  if (nonce && verdict.nonce !== nonce) return { ok: false, reason: "nonce" };
  const issued = Date.parse(verdict.issued_at);
  if (!Number.isFinite(issued)) return { ok: false, reason: "issued_at" };
  if (Math.abs(now - issued) > skewSec * 1000) return { ok: false, reason: "skew" };
  return { ok: true, verdict };
}

export function randomHex(nBytes) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sixDigitCode() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(String(text || "")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { canonical, toB64Url, fromB64Url };
