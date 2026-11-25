"use strict";

const {createHmac, timingSafeEqual} = require("node:crypto");

function verifier(token) {
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return function verify(initData, now = Date.now()) {
    if (typeof initData !== "string" || initData.length > 8192) return null;
    const params = new URLSearchParams(initData);
    if (new Set(params.keys()).size !== params.size) return null;
    const hash = params.get("hash");
    const authDate = Number(params.get("auth_date"));
    if (!/^[0-9a-f]{64}$/.test(hash ?? "") || !Number.isSafeInteger(authDate)) return null;
    if (authDate * 1000 > now + 60_000 || authDate * 1000 < now - 86_400_000) return null;
    params.delete("hash");
    params.sort();
    const check = [...params].map(([key, value]) => key + "=" + value).join("\n");
    const expected = createHmac("sha256", secret).update(check).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;

    try {
      const user = JSON.parse(params.get("user"));
      if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.first_name !== "string") return null;
      const name = [user.first_name, user.last_name].filter(value => typeof value === "string")
        .join(" ").trim().slice(0, 120) || "Игрок";
      let photo = null;
      if (typeof user.photo_url === "string" && user.photo_url.length <= 1024) {
        try {
          const url = new URL(user.photo_url);
          if (url.protocol === "https:" && !url.username && !url.password) photo = url.href;
        } catch {}
      }
      return {id:user.id, name, photo};
    } catch {
      return null;
    }
  };
}

module.exports = {verifier};
