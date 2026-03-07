import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import morgan from "morgan";
import Mux from "@mux/mux-node";

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

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(morgan("dev"));

function safeJsonParse(value) {
    if (!value || typeof value !== "string") return null;
    try { return JSON.parse(value); } catch { return null; }
}

function extractCategory(asset) {
    const fromPassthrough = safeJsonParse(asset.passthrough);
    if (fromPassthrough?.category) return fromPassthrough.category;

    const fromMetaTitle = safeJsonParse(asset.meta?.title); // <- đọc từ Dashboard Metadata Title
    if (fromMetaTitle?.category) return fromMetaTitle.category;

    return process.env.DEFAULT_CATEGORY || "uncategorized";
}

function extractTitle(asset) {
    const fromPassthrough = safeJsonParse(asset.passthrough);
    if (fromPassthrough?.title) return fromPassthrough.title;

    const fromMetaTitle = safeJsonParse(asset.meta?.title);
    if (fromMetaTitle?.title) return fromMetaTitle.title;

    return asset.meta?.title || asset.id;
}


function normalizeVideo(asset) {
    const publicPlayback = (asset.playback_ids || []).find((x) => x.policy === "public");
    if (!publicPlayback) return null;
    return {
        id: asset.id,
        title: extractTitle(asset),
        playbackId: publicPlayback.id,
        duration: asset.duration || 0,
        status: asset.status,
        createdAt: asset.created_at || null,
    };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/videos", async (_req, res) => {
    try {
        const grouped = new Map();
        let page;
        do {
            const result = await mux.video.assets.list({ limit: 100, page });
            for (const asset of result.data || []) {
                const video = normalizeVideo(asset);
                if (!video) continue;
                const category = extractCategory(asset);
                if (!grouped.has(category)) grouped.set(category, []);
                grouped.get(category).push(video);
            }
            page = result.next_page;
        } while (page);

        const categories = Array.from(grouped.entries()).map(([category, videos]) => ({
            category,
            videos,
        }));
        res.json(categories);
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
