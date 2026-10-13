function safeJsonParse(value) {
    if (!value || typeof value !== "string") return null;
    try { return JSON.parse(value); } catch { return null; }
}

async function fetchCategories(mux, defaultCategory) {
    const grouped = new Map();

    // The SDK iterator fetches every page; list responses have no next_page field.
    for await (const asset of mux.video.assets.list({ limit: 100 })) {
        const publicPlayback = (asset.playback_ids || []).find((id) => id.policy === "public");
        if (!publicPlayback) continue;

        const passthrough = safeJsonParse(asset.passthrough);
        const metadata = safeJsonParse(asset.meta?.title);
        const category = passthrough?.category || metadata?.category || defaultCategory;
        const video = {
            id: asset.id,
            title: passthrough?.title || metadata?.title || asset.meta?.title || asset.id,
            playbackId: publicPlayback.id,
            duration: asset.duration || 0,
            status: asset.status,
            createdAt: asset.created_at || null,
        };

        if (!grouped.has(category)) grouped.set(category, []);
        grouped.get(category).push(video);
    }

    return Array.from(grouped, ([category, videos]) => ({ category, videos }));
}

export function createVideoListLoader(mux, {
    defaultCategory = "uncategorized",
    cacheTtlMs = 60_000,
    now = Date.now,
    onRefreshError = (error) => console.error("Background video refresh failed:", error),
} = {}) {
    let cachedCategories;
    let expiresAt = 0;
    let inFlight;

    function refresh() {
        // Concurrent visitors share one Mux request, including on a cold cache.
        if (!inFlight) {
            inFlight = fetchCategories(mux, defaultCategory)
                .then((categories) => {
                    cachedCategories = categories;
                    expiresAt = now() + cacheTtlMs;
                    return categories;
                })
                .finally(() => { inFlight = null; });
        }
        return inFlight;
    }

    return async function loadVideos() {
        if (!cachedCategories) return refresh();

        // Stale-while-revalidate: once a list exists, visitors never wait on Mux.
        // An expired list is returned immediately and refreshed in the background.
        if (now() >= expiresAt) refresh().catch(onRefreshError);
        return cachedCategories;
    };
}
