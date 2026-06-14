import { getQuotes } from "../server/index.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await getQuotes());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
