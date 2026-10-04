import assert from "node:assert/strict";
import test from "node:test";
import Mux from "@mux/mux-node";
import { createVideoListLoader } from "./video-list.js";

function publicAsset(id, overrides = {}) {
    return {
        id,
        status: "ready",
        playback_ids: [{ id: `playback-${id}`, policy: "public" }],
        ...overrides,
    };
}

function stubMux(fetchAssets) {
    return {
        video: {
            assets: {
                list(options) {
                    return {
                        async *[Symbol.asyncIterator]() {
                            yield* await fetchAssets(options);
                        },
                    };
                },
            },
        },
    };
}

test("preserves categories and metadata while excluding private assets", async () => {
    const mux = stubMux(async () => [
        publicAsset("first", {
            passthrough: JSON.stringify({ category: "products", title: "Product demo" }),
            meta: { title: JSON.stringify({ category: "ignored", title: "Ignored" }) },
            duration: 12,
            created_at: "123",
        }),
        publicAsset("second", {
            passthrough: "invalid JSON",
            meta: { title: JSON.stringify({ category: "products", title: "Second demo" }) },
        }),
        publicAsset("third", { meta: { title: "Plain title" } }),
        publicAsset("fourth"),
        publicAsset("private", { playback_ids: [{ id: "signed-id", policy: "signed" }] }),
        { id: "no-playback" },
    ]);
    const categories = await createVideoListLoader(mux, { defaultCategory: "other" })();

    assert.deepEqual(categories.map(({ category, videos }) => ({
        category,
        ids: videos.map(({ id }) => id),
        titles: videos.map(({ title }) => title),
    })), [
        { category: "products", ids: ["first", "second"], titles: ["Product demo", "Second demo"] },
        { category: "other", ids: ["third", "fourth"], titles: ["Plain title", "fourth"] },
    ]);
    assert.deepEqual(categories[0].videos[0], {
        id: "first",
        title: "Product demo",
        playbackId: "playback-first",
        duration: 12,
        status: "ready",
        createdAt: "123",
    });
});

test("caches responses for 60 seconds and refreshes at expiry", async () => {
    let time = 0;
    let requests = 0;
    const mux = stubMux(async () => [publicAsset(`asset-${++requests}`)]);
    const loadVideos = createVideoListLoader(mux, { now: () => time });
    const first = await loadVideos();

    time = 59_999;
    assert.strictEqual(await loadVideos(), first);
    assert.equal(requests, 1);

    time = 60_000;
    const refreshed = await loadVideos();
    assert.equal(requests, 2);
    assert.equal(refreshed[0].videos[0].id, "asset-2");
});

test("concurrent requests share one Mux listing and TTL starts after it completes", async () => {
    let time = 0;
    let requests = 0;
    let resolveAssets;
    const assets = new Promise((resolve) => { resolveAssets = resolve; });
    const loadVideos = createVideoListLoader(stubMux(() => {
        requests += 1;
        return assets;
    }), { now: () => time });
    const pending = [loadVideos(), loadVideos(), loadVideos()];

    assert.equal(requests, 1);
    time = 30_000;
    resolveAssets([publicAsset("shared")]);
    const responses = await Promise.all(pending);
    assert.ok(responses.every((response) => response === responses[0]));

    time = 89_999;
    assert.strictEqual(await loadVideos(), responses[0]);
    assert.equal(requests, 1);
});

test("failed requests are released so the next visit can retry", async () => {
    let requests = 0;
    const loadVideos = createVideoListLoader(stubMux(async () => {
        requests += 1;
        if (requests === 1) throw new Error("Mux unavailable");
        return [publicAsset("recovered")];
    }));

    const failures = await Promise.allSettled([loadVideos(), loadVideos()]);
    assert.ok(failures.every(({ status }) => status === "rejected"));
    assert.equal(requests, 1);
    assert.equal((await loadVideos())[0].videos[0].id, "recovered");
    assert.equal(requests, 2);
});

test("empty lists are cached", async () => {
    let requests = 0;
    const loadVideos = createVideoListLoader(stubMux(async () => {
        requests += 1;
        return [];
    }));

    assert.deepEqual(await loadVideos(), []);
    assert.deepEqual(await loadVideos(), []);
    assert.equal(requests, 1);
});

test("the installed Mux SDK iterates beyond the first 100 assets", async () => {
    const requestedPages = [];
    const mux = new Mux({
        tokenId: "test-id",
        tokenSecret: "test-secret",
        fetch: async (url) => {
            const page = Number(new URL(url).searchParams.get("page") || 1);
            requestedPages.push(page);
            const data = page === 1
                ? Array.from({ length: 100 }, (_, index) => publicAsset(`asset-${index}`))
                : page === 2 ? [publicAsset("last-asset")] : [];
            return new Response(JSON.stringify({ data }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const categories = await createVideoListLoader(mux)();

    assert.deepEqual(requestedPages, [1, 2, 3]);
    assert.equal(categories[0].videos.length, 101);
    assert.equal(categories[0].videos.at(-1).id, "last-asset");
});
