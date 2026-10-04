import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import morgan from "morgan";
import Mux from "@mux/mux-node";
import { createVideoListLoader } from "./video-list.js";

dotenv.config();

const {
    PORT = 5002,
    FRONTEND_ORIGIN = "http://localhost:5173",
    MUX_TOKEN_ID,
    MUX_TOKEN_SECRET,
    DEFAULT_CATEGORY = "uncategorized",
} = process.env;

if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    console.error("Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET");
    process.exit(1);
}

const app = express();
const mux = new Mux({ tokenId: MUX_TOKEN_ID, tokenSecret: MUX_TOKEN_SECRET });
const loadVideos = createVideoListLoader(mux, { defaultCategory: DEFAULT_CATEGORY });

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/videos", async (_req, res) => {
    try {
        res.json(await loadVideos());
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to fetch videos" });
    }
});

app.post("/api/uploads/direct", async (req, res) => {
    try {
        const { title = "", category = DEFAULT_CATEGORY, corsOrigin } = req.body || {};
        const passthrough = JSON.stringify({ title, category });

        const upload = await mux.video.uploads.create({
            cors_origin: corsOrigin || FRONTEND_ORIGIN,
            new_asset_settings: { playback_policy: ["public"], passthrough },
        });

        res.status(201).json({
            uploadId: upload.id,
            url: upload.url,
            status: upload.status,
            timeout: upload.timeout,
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to create upload URL" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
