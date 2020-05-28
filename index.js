function toQuadKey(x, y, z) {
    var index = "";
    for (var i = z; i > 0; i--) {
        var b = 0;
        var mask = 1 << (i - 1);
        if ((x & mask) !== 0) b++;
        if ((y & mask) !== 0) b += 2;
        index += b.toString();
    }
    return index;
}

const STATUS_CODES = {
    403: "Forbidden",
    404: "Not Found",
};

async function handleError(status) {
    return new Response(status, {
        status,
        statusText: STATUS_CODES[status],
    });
}

// https://docs.microsoft.com/en-us/bingmaps/rest-services/imagery/get-imagery-metadata
const METADATA_URL =
    "https://dev.virtualearth.net/REST/v1/Imagery/Metadata/{imagerySet}?key={key}&uriScheme=https";

async function getCacheKey(imagerySet, key) {
    const buffer = new TextEncoder("utf-8").encode(key);
    const digest = await crypto.subtle.digest("SHA-1", buffer);
    return `${imagerySet}:${digest}`;
}

async function getTemplate(imagerySet, key) {
    const cacheKey = await getCacheKey(imagerySet, key);
    return ENDPOINTS.get(cacheKey);
}

async function refreshTemplate(imagerySet, key) {
    const metadataRes = await fetch(
        METADATA_URL.replace("{imagerySet}", imagerySet).replace("{key}", key)
    );

    if (!metadataRes.ok) {
        throw new Error("Forbidden");
    }

    const metadata = await metadataRes.json();
    const resource = metadata.resourceSets[0].resources[0];
    const subdomain = resource.imageUrlSubdomains[0];
    const template = resource.imageUrl.replace("{subdomain}", subdomain);

    const cacheKey = await getCacheKey(imagerySet, key);
    await ENDPOINTS.put(cacheKey, template);
    return template;
}

async function fetchTile(template, quadkey, zoom, culture) {
    return fetch(
        template
            .replace("{quadkey}", quadkey)
            .replace("{culture}", culture)
            .replace("{zoom}", zoom)
    );
}

async function handleRequest(request) {
    const url = new URL(request.url);
    const query = [
        ...new URLSearchParams(url.search.slice(1)).entries(),
    ].reduce((q, [k, v]) => Object.assign(q, { [k]: v }), {});

    if (!query.key) {
        return handleError(403);
    }

    const m = url.pathname.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+).jpg$/m);

    if (m === null) {
        return handleError(404);
    }

    const culture = query.culture || "en-US";
    const [path, imagerySet, z, x, y] = m;
    const quadkey = toQuadKey(x, y, z);

    // Get cached tile template
    let template = await getTemplate(imagerySet, query.key);

    // Refresh if not cached
    if (!template) {
        try {
            template = await refreshTemplate(imagerySet, query.key);
        } catch (e) {
            return handleError(403);
        }
    }

    // Get tile
    let tile = await fetchTile(template, quadkey, z, culture);

    // Possible that the template is expired, refresh and fetch again
    if (!tile.ok) {
        try {
            template = await refreshTemplate(imagerySet, query.key);
        } catch (e) {
            return handleError(403);
        }

        tile = await fetchTile(template, quadkey, z, culture);
    }

    // Return tile
    return new Response(tile.body, {
        status: tile.status,
        statusText: tile.statusText,
        headers: tile.headers,
    });
}

addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});
