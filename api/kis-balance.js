import { getKisBalance } from "../server/kis.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await getKisBalance());
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.details || null,
      checkedAt: new Date().toISOString(),
    });
  }
}
