const express = require('express');
const axios = require('axios');
const path = require('path');
const cloudscraper = require('cloudscraper');
const http = require('http');
const https = require('https');
const { SocksClient } = require('socks');
const tls = require('tls');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 25 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });
const ax = axios.create({ httpAgent, httpsAgent });

let warpAgent = null;
try {
    warpAgent = new (class extends https.Agent {
        createConnection(options, cb) {
            SocksClient.createConnection({
                proxy: { host: '127.0.0.1', port: 1080, type: 5 },
                command: 'connect',
                destination: { host: options.host, port: options.port },
                timeout: 15000,
            }).then(({ socket }) => {
                socket.setKeepAlive(false);
                const tlsSocket = tls.connect({ socket, servername: options.servername || options.host, host: options.host, port: options.port, rejectUnauthorized: false });
                tlsSocket.on('error', () => {});
                cb(null, tlsSocket);
            }).catch((err) => cb(err));
        }
    })({ keepAlive: false, timeout: 15000 });
} catch {}

// --- playlist cache: pre-fetched variant m3u8 content (60s TTL) ---
const plCache = new Map();
function cacheSet(k, v) { plCache.set(k, v); setTimeout(() => plCache.delete(k), 60000); }

// --- segment cache: short-lived binary segment cache (5s TTL) for buffering ---
const segCache = new Map();
function segCacheSet(k, v) { segCache.set(k, v); setTimeout(() => segCache.delete(k), 5000); }

const app = express();
app.set('trust proxy', true);
app.use((_r, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (_r.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

const ADDON_ID = 'org.itastream.addon';
const ADDON_NAME = 'ItaStream';
const VERSION = '1.0.0';
const META_MANIFEST = process.env.META_MANIFEST || 'https://v3-cinemeta.strem.io/manifest.json';
const CATALOG_BASE = (() => { let b = META_MANIFEST.replace(/\/manifest\.json$/, ''); return b.endsWith('/') ? b : b + '/'; })();

function qs(r) { const i = r.url.indexOf('?'); return i >= 0 ? r.url.substring(i) : ''; }

// --- cache ---
const cache = new Map();
async function getManifest(base) {
    if (cache.has(base)) return cache.get(base);
    const { data } = await ax.get(base + 'manifest.json', { timeout: 10000 });
    cache.set(base, data);
    setTimeout(() => cache.delete(base), 600000);
    return data;
}

// --- MANIFEST ---
app.get('/manifest.json', async (_req, res) => {
    try {
        const sm = await getManifest(CATALOG_BASE);
        res.json({
            id: ADDON_ID, version: VERSION, name: `${ADDON_NAME} (${sm.name || 'Source'})`,
            description: 'ItaStream — streaming Italia', resources: ['catalog', 'stream', 'meta'],
            types: sm.types || ['movie', 'series'], catalogs: sm.catalogs || [],
            idPrefixes: sm.idPrefixes || ['tt', 'tmdb'],
            behaviorHints: { configurable: false, configurationRequired: false },
        });
    } catch (e) {
        res.json({
            id: ADDON_ID, version: VERSION, name: ADDON_NAME, description: 'Streaming Italia',
            resources: ['stream'], types: ['movie', 'series'], catalogs: [], idPrefixes: ['tt', 'tmdb'],
            behaviorHints: { configurable: false, configurationRequired: false },
        });
    }
});

app.get('/catalog/:type/*.json', async (req, res) => {
    try {
        const ep = `catalog/${req.params.type}/${req.params[0]}.json` + qs(req);
        const { data } = await ax.get(CATALOG_BASE + ep, { timeout: 15000 });
        res.json(data);
    } catch { res.json({ metas: [] }); }
});
app.get('/meta/:type/*.json', async (req, res) => {
    try {
        const ep = `meta/${req.params.type}/${req.params[0]}.json` + qs(req);
        const { data } = await ax.get(CATALOG_BASE + ep, { timeout: 15000 });
        res.json(data);
    } catch { res.json({ meta: {} }); }
});

// --- VixSrc HTTP ---
const VIXSRC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};

async function vixsrcHTTP(apiUrl) {
    try {
        const { data: api } = await ax.get(apiUrl, { timeout: 8000 });
        if (!api?.src) return null;
        let embed = api.src.startsWith('http') ? api.src : `https://vixsrc.to${api.src}`;
        embed = embed.replace(/vixcloud\.co/g, 'calpezz8.space').replace(/vixsrc\.to/g, 'calpezz8.space');

        let html = null;
        try { html = await cloudscraper.get(embed, { timeout: 12000 }); } catch {}
        if (!html) {
            try {
                const r = await ax.get(embed, { timeout: 12000, headers: { ...VIXSRC_HEADERS, Referer: embed } });
                html = r.data;
            } catch {}
        }
        if (!html || typeof html !== 'string') return null;

        // 1) Extract from window.masterPlaylist structure
        const mpMatch = html.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?params\s*:\s*\{(?<params>[\s\S]*?)\}\s*,\s*url\s*:\s*['"](?<url>[^'"]+)['"]/);
        if (mpMatch) {
            const paramsBlock = mpMatch.groups.params;
            const playlistUrl = mpMatch.groups.url.replace(/\\\//g, '/');
            const tokenM = paramsBlock.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
            const expM = paramsBlock.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
            const asnM = paramsBlock.match(/['"]asn['"]\s*:\s*['"]([^'"]*)['"]/);
            if (tokenM && expM) {
                const up = new URL(playlistUrl);
                up.searchParams.set('token', tokenM[1]);
                up.searchParams.set('expires', expM[1]);
                if (/window\.canPlayFHD\s*=\s*true/.test(html)) up.searchParams.set('h', '1');
                up.searchParams.set('lang', 'it');
                if (asnM && asnM[1]) up.searchParams.set('asn', asnM[1]);
                return up.toString();
            }
        }

        // 2) Legacy: extract url, token, expires from script
        const urlMatch = html.match(/url\s*:\s*['"]([^'"]+?)['"]/);
        const tokenMatch = html.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
        const expMatch = html.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
        if (urlMatch && tokenMatch && expMatch) {
            const up = new URL(urlMatch[1].replace(/\\\//g, '/'));
            up.searchParams.set('token', tokenMatch[1]);
            up.searchParams.set('expires', expMatch[1]);
            if (/canPlayFHD/i.test(html)) up.searchParams.set('h', '1');
            up.searchParams.set('lang', 'it');
            return up.toString();
        }

        // 3) Fallback: extract from data-page JSON (like EasyProxy)
        const dpMatch = html.match(/<div[^>]*id="app"[^>]*data-page="([^"]*)"/);
        if (dpMatch) {
            try {
                const data = JSON.parse(dpMatch[1].replace(/&quot;/g, '"'));
                const search = (obj) => {
                    if (!obj || typeof obj !== 'object') return {};
                    if (Array.isArray(obj)) {
                        for (const item of obj) {
                            const r = search(item);
                            if (r.url && r.token && r.expires) return r;
                        }
                        return {};
                    }
                    let found = {};
                    for (const [k, v] of Object.entries(obj)) {
                        const kl = k.toLowerCase();
                        if (['token', 'expires', 'url'].includes(kl) && typeof v === 'string') found[kl] = v;
                        else {
                            const nested = search(v);
                            Object.assign(found, nested);
                        }
                        if (found.url && found.token && found.expires) break;
                    }
                    return found;
                };
                const result = search(data);
                if (result.url && result.token && result.expires) {
                    const up = new URL(result.url);
                    up.searchParams.set('token', result.token);
                    up.searchParams.set('expires', result.expires);
                    if (/canPlayFHD/i.test(html)) up.searchParams.set('h', '1');
                    up.searchParams.set('lang', 'it');
                    return up.toString();
                }
            } catch {}
        }
        return null;
    } catch { return null; }
}

// --- VidxGo HTTP (XOR decrypt) ---
function xorDecrypt(b64, key) {
    const d = Buffer.from(b64, 'base64');
    const r = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) r[i] = d[i] ^ key.charCodeAt(i % key.length);
    return r.toString('utf-8');
}

const VIDXGO_EMBED_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    'Referer': 'https://altadefinizione.you/',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
};

const VIDXGO_PLAYBACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    'Referer': 'https://v.vidxgo.co/',
    'Origin': 'https://v.vidxgo.co',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
};

async function vidxgoHTTP(url) {
    try {
        const resp = await ax.get(url, { timeout: 12000, headers: VIDXGO_EMBED_HEADERS });
        const html = resp.data;
        if (!html || html.length < 200) return null;
        // Extract all <script> contents
        const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let scripts = [];
        let sm;
        while ((sm = scriptRe.exec(html)) !== null) scripts.push(sm[1]);
        const obfuscatedRe = /var\s+(\w+)\s*=\s*'([^']+)'\s*,\s*d\s*=\s*atob\s*\(\s*'([^']+)'/g;
        for (const script of scripts) {
            let om;
            while ((om = obfuscatedRe.exec(script)) !== null) {
                try {
                    const dec = xorDecrypt(om[3], om[2]);
                    const cm = dec.match(/\bcurrentSrc\s*=\s*["'](https?:[^"']+?\.m3u8[^"']*)["']/);
                    if (cm) return cm[1].replace(/\\/g, '');
                } catch {}
            }
        }
        if (html.includes('player-container') && html.includes('corrupt')) return null;
        return null;
    } catch { return null; }
}

// --- STREAM ---
app.get('/stream/:type/:id.json', async (req, res) => {
    const parts = req.params.id.split(':');
    const realId = parts[0];
    const season = req.query.season || parts[1] || 1;
    const episode = req.query.episode || parts[2] || 1;
    const imdbId = realId;
    const isMovie = req.params.type === 'movie';

    let title = realId;
    ax.get(`https://v3-cinemeta.strem.io/meta/${req.params.type}/${realId}.json`, { timeout: 5000 })
        .then(() => {}).catch(() => {});
    try {
        const { data } = await ax.get(`https://v3-cinemeta.strem.io/meta/${req.params.type}/${realId}.json`, { timeout: 4000 });
        if (data?.meta?.name) title = data.meta.name;
    } catch {}

    const streams = [];
    const proxy = (d) => `${manifestBase(req)}/proxy/manifest.m3u8?d=${encodeURIComponent(d)}`;

    const apiUrl = isMovie
        ? `https://calpezz8.space/api/movie/${imdbId}`
        : `https://calpezz8.space/api/tv/${imdbId}/${season}/${episode}`;
    streams.push({ name: isMovie ? `🎬 VixSrc ${title}` : `📺 VixSrc ${title} S${season}E${episode}`, title, url: proxy(apiUrl) });
    streams.push({ name: isMovie ? `🎬 VixSrc ${title} [HD]` : `📺 VixSrc ${title} S${season}E${episode} [HD]`, title, url: proxy(apiUrl) + '&q=best' });

    const vUrl = isMovie ? `https://v.vidxgo.co/${imdbId}` : `https://v.vidxgo.co/${imdbId}/${season}/${episode}`;
    streams.push({ name: `⚡ VidxGo ${title}`, title, url: proxy(vUrl) });
    streams.push({ name: `⚡ VidxGo ${title} [HD]`, title, url: proxy(vUrl) + '&q=best' });

    try {
        const tmdbKey = '4ef0d7355d9ffb5151e987764708ce96';
        const { data: tmdb } = await ax.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id`, { timeout: 5000 });
        const key = isMovie ? 'movie_results' : 'tv_results';
        const tmdbId = tmdb[key]?.[0]?.id || tmdb[(key === 'movie_results' ? 'tv_results' : 'movie_results')]?.[0]?.id;
        if (tmdbId) {
            const s = isMovie ? 'movie' : season;
            const e = isMovie ? 'movie' : episode;
            streams.push({ name: `🏛️ ADN ${title}`, title, url: `${manifestBase(req)}/proxy/adn/${tmdbId}/${s}/${e}/master.mp4` });
        }
    } catch {}

    streams.push({ name: `🪞 NetMirror ${title}`, title, url: `${manifestBase(req)}/proxy/netmirror?d=${encodeURIComponent(imdbId)}&s=${season}&e=${episode}&t=${req.params.type}&q=best` });

    res.json({ streams });
});

function proxyBase(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}/proxy/segment?url=`;
}
function manifestBase(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}`;
}
function rewriteM3U8(body, baseUrl, proxySegmentBase) {
    const proxySegmentPrefix = proxySegmentBase.replace('?url=', '');
    const lines = body.split('\n');
    const result = [];
    for (let line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) {
            line = new URL(trimmed, baseUrl).toString();
        }
        line = line.replace(/URI\s*=\s*"([^"]+)"/g, (full, uri) => {
            let abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).toString();
            return `URI="${proxySegmentBase}${encodeURIComponent(abs)}"`;
        });
        result.push(line);
    }
    let body2 = result.join('\n');
    body2 = body2.replace(/(https?:\/\/[^\s"'\n]+)/g, (m) => {
        if (m.startsWith(proxySegmentPrefix)) return m;
        return `${proxySegmentBase}${encodeURIComponent(m)}`;
    });
    return body2;
}
function simplifyMaster(body) {
    const lines = body.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
            const bw = lines[i].match(/BANDWIDTH=(\d+)/);
            const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
            variants.push({ idx: i, bandwidth: bw ? parseInt(bw[1]) : 0, height: res ? parseInt(res[2]) : 0 });
        }
    }
    if (variants.length <= 1) return body;
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const best = variants[0];
    const after = variants.filter(v => v.idx > best.idx).map(v => v.idx - 1);
    const stop = after.length ? Math.min(...after) : lines.length - 1;
    const out = ['#EXTM3U'];
    for (let i = 1; i <= stop; i++) {
        if (i < best.idx && !lines[i].startsWith('#EXT-X-MEDIA:')) continue;
        if (i > best.idx && lines[i].startsWith('#EXT-X-MEDIA:')) continue;
        out.push(lines[i]);
    }
    return out.join('\n');
}

app.get('/proxy/manifest.m3u8', async (req, res) => {
    const { d } = req.query;
    if (!d) return res.status(400).send('Missing d');
    try {
        const isVixSrc = d.includes('vixsrc') || d.includes('calpezz8');
        const isVidxGo = d.includes('vidxgo');
        let rawUrl;
        if (isVixSrc) rawUrl = await vixsrcHTTP(d);
        else if (isVidxGo) rawUrl = await vidxgoHTTP(d);
        else rawUrl = await vidxgoHTTP(d) || await vixsrcHTTP(d);
        if (!rawUrl) return res.status(404).send('No video found');

        console.error('m3u8:', rawUrl.substring(0, 120));

        const fetchHeaders = isVidxGo
            ? { ...VIDXGO_PLAYBACK_HEADERS }
            : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', 'Accept': '*/*' };
        const resp = await ax.get(rawUrl, { timeout: 8000, responseType: 'text', headers: fetchHeaders });
        let body = rewriteM3U8(resp.data, rawUrl, proxyBase(req));
        if (req.query.q === 'best') body = simplifyMaster(body);

        // Pre-fetch variant playlists in parallel (like EasyProxy)
        const base = proxyBase(req);
        const variantUrls = [];
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const prev = i > 0 ? lines[i - 1] : '';
            if (prev.startsWith('#EXT-X-STREAM-INF') || prev.startsWith('#EXT-X-MEDIA')) {
                const u = lines[i].trim();
                if (u.startsWith(base.replace('?url=', ''))) {
                    variantUrls.push(u);
                }
            }
            // Also URI= in #EXT-X-I-FRAME-STREAM-INF
            const uriM = lines[i].match(/URI="([^"]+)"/);
            if (uriM && uriM[1].startsWith('http')) variantUrls.push(uriM[1]);
        }
        // Fire-and-forget pre-fetch (don't block response)
        variantUrls.forEach(u => {
            const realUrl = decodeURIComponent(new URL(u).searchParams.get('url') || '');
            if (realUrl && !plCache.has(realUrl)) {
                const hdrs = realUrl.includes('.d2b.you') || realUrl.includes('media-')
                    ? { ...VIDXGO_PLAYBACK_HEADERS }
                    : realUrl.includes('freecdn1.top') || realUrl.includes('subscdn.top')
                    ? { 'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer', 'Referer': 'https://tv.imgcdn.kim/', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' }
                    : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', 'Accept': '*/*' };
                ax.get(realUrl, { timeout: 8000, responseType: 'arraybuffer', headers: hdrs })
                    .then(r => cacheSet(realUrl, r))
                    .catch(() => {});
            }
        });

        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(body);
    } catch (e) { console.error('Proxy m3u8 error:', e.message); res.status(500).send(e.message); }
});

const ADN_BASE = 'https://altadefinizionestreaming.com';
const ADN_COOKIE = 'sid=32234dfabd14e587764e84405e75e99856c6bef31c6b1752e19897b8ae3d4a21';
const ADN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';

app.get('/proxy/adn/:tmdbId/:season/:episode/master.mp4', async (req, res) => {
    try {
        const { tmdbId, season, episode } = req.params;
        const isMovie = season === 'movie' || episode === 'movie';
        const apiPath = isMovie
            ? `/api/player-sources/movie/${encodeURIComponent(tmdbId)}`
            : `/api/player-sources/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;

        const fetch = require('node-fetch');
        const opts = { timeout: 15000, headers: { 'User-Agent': ADN_UA, 'Accept': 'application/json,text/plain,*/*', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', 'Referer': ADN_BASE + '/', 'Cookie': ADN_COOKIE } };
        if (warpAgent) opts.agent = warpAgent;

        const apiResp = await fetch(ADN_BASE + apiPath, opts);
        if (!apiResp.ok) { console.error('[proxy/adn] API status:', apiResp.status); return res.status(502).send('ADN API error'); }
        const payload = await apiResp.json();
        const sources = payload?.sources || [];
        const cdnSource = sources.find(s => s.provider === 'cdn' && s.url) || sources.find(s => s.url);
        if (!cdnSource?.url) return res.status(404).send('No CDN source');
        console.error('[proxy/adn] CDN:', cdnSource.url.substring(0, 120));

        const range = req.headers.range || '';
        const cdnOpts = { timeout: 15000, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': ADN_BASE + '/' } };
        if (range) cdnOpts.headers['Range'] = range;
        if (warpAgent) cdnOpts.agent = warpAgent;

        const upstream = await fetch(cdnSource.url, cdnOpts);
        if (!upstream.ok && upstream.status !== 206) {
            console.error('[proxy/adn] CDN upstream:', upstream.status, 'url:', cdnSource.url.substring(0, 100));
            return res.status(upstream.status).send('cdn error');
        }
        const ct = upstream.headers.get('content-type') || 'video/mp4';
        const cl = upstream.headers.get('content-length');
        const cr = upstream.headers.get('content-range');
        res.status(upstream.status);
        res.set('Content-Type', ct);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Accept-Ranges', 'bytes');
        if (cr) res.set('Content-Range', cr);
        if (cl) res.set('Content-Length', cl);
        upstream.body.pipe(res);
        } catch (e) {
            console.error('[proxy/adn]', e.message);
            if (e.response) console.error('[proxy/adn] status:', e.response.status, 'url:', (e.config?.url || '').substring(0, 100));
            res.status(502).send('ADN proxy error');
        }
});

const NM_API = 'https://tv.imgcdn.kim/newtv';
const NM_TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
const NM_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0', 'x-requested-with': 'NetmirrorNewTV v1.0' };
const NM_SERVICES = [{ code: 'nf', name: 'Netflix' }, { code: 'pv', name: 'PrimeVideo' }, { code: 'hs', name: 'Hotstar' }];

app.get('/proxy/netmirror', async (req, res) => {
    const { d, s, e, t } = req.query;
    if (!d) return res.status(400).send('Missing d (imdb id)');
    try {
        const isMovie = t === 'movie';
        const season = parseInt(s) || 1;
        const episode = parseInt(e) || 1;

        const { data: tmdbData } = await ax.get(`https://api.themoviedb.org/3/find/${d}?api_key=${NM_TMDB_KEY}&external_source=imdb_id`, { timeout: 5000 });
        const key = isMovie ? 'movie_results' : 'tv_results';
        const tmdbId = String((tmdbData[key]?.[0] || tmdbData[(key === 'movie_results' ? 'tv_results' : 'movie_results')]?.[0])?.id || '');
        if (!tmdbId) return res.status(404).send('TMDB not found');

        const { data: media } = await ax.get(`https://api.themoviedb.org/3/${isMovie ? 'movie' : 'tv'}/${tmdbId}?api_key=${NM_TMDB_KEY}&language=en-US`, { timeout: 5000 });
        const titles = [...new Set([media.name || media.title, media.original_name || media.original_title].filter(Boolean))];

        let m3u8Url = null;
        for (const svc of NM_SERVICES) {
            try {
                const hdrs = { ...NM_HEADERS, ott: svc.code };
                let netId = null;
                for (const title of titles) {
                    const { data: sr } = await ax.get(`${NM_API}/search.php?s=${encodeURIComponent(title)}`, { timeout: 8000, headers: hdrs });
                    const results = sr?.searchResult || [];
                    const match = results.find(r => r?.id && String(r.t || '').toLowerCase() === title.toLowerCase()) || results.find(r => r?.id);
                    if (match) { netId = match.id; break; }
                }
                if (!netId) continue;

                let finalId = netId;
                if (!isMovie) {
                    const { data: post } = await ax.get(`${NM_API}/post.php?id=${encodeURIComponent(netId)}`, { timeout: 8000, headers: hdrs });
                    const sEntry = (post?.season || []).find(i => i?.id && String(i.s || '').includes(`Season ${season}`));
                    if (!sEntry) continue;
                    let page = 1, epId = null;
                    while (page < 10 && !epId) {
                        const { data: epData } = await ax.get(`${NM_API}/episodes.php?id=${encodeURIComponent(sEntry.id)}&page=${page}`, { timeout: 8000, headers: hdrs });
                        const eps = epData?.episodes || [];
                        epId = eps.find(ep => ep?.id && String(ep.ep || '') === String(episode))?.id;
                        if (!epId && parseInt(epData?.nextPageShow) !== 1) break;
                        page++;
                    }
                    if (!epId) continue;
                    finalId = epId;
                }

                const { data: player } = await ax.get(`${NM_API}/player.php?id=${encodeURIComponent(finalId)}`, { timeout: 8000, headers: hdrs });
                if (player?.video_link) { m3u8Url = player.video_link; break; }
            } catch {}
        }

        if (!m3u8Url) return res.status(404).send('No stream found');

        const resp = await ax.get(m3u8Url, { timeout: 10000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer', 'Referer': NM_API + '/', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' } });
        let body = rewriteM3U8(resp.data, m3u8Url, proxyBase(req));
        if (req.query.q === 'best') body = simplifyMaster(body);
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(body);
    } catch (e) { console.error('NetMirror error:', e.message); res.status(502).send('NetMirror failed'); }
});

app.get('/proxy/segment', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');
    try {
        const isPlaylist = url.includes('.m3u8');
        // Check pre-fetch cache for playlists
        if (isPlaylist && plCache.has(url)) {
            const cached = plCache.get(url);
            let body = Buffer.isBuffer(cached.data) ? cached.data.toString('utf-8') : cached.data;
            body = rewriteM3U8(body, url, proxyBase(req));
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(body);
        }

        // Segment cache for non-playlist (video segments)
        if (!isPlaylist && segCache.has(url)) {
            const cached = segCache.get(url);
            res.set('Content-Type', cached.ct || 'video/mp2t');
            return res.send(cached.data);
        }

        const isVidxGoCDN = url.includes('.d2b.you') || url.includes('media-') || url.includes('vidxgo');
        const isNetMirrorCDN = url.includes('freecdn1.top') || url.includes('subscdn.top');
        let fetchHeaders;
        if (isVidxGoCDN) fetchHeaders = { ...VIDXGO_PLAYBACK_HEADERS };
        else if (isNetMirrorCDN) fetchHeaders = { 'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer', 'Referer': 'https://tv.imgcdn.kim/', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' };
        else fetchHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', 'Accept': '*/*' };
        let data, ct;
        try {
            const r = await ax.get(url, { timeout: isPlaylist ? 8000 : 12000, responseType: 'arraybuffer', headers: fetchHeaders });
            data = r.data; ct = r.headers['content-type'] || '';
        } catch (e1) {
            console.error('Segment fetch failed:', e1.message);
            try {
                data = await cloudscraper.get(url, { timeout: 10000, encoding: null });
                ct = 'video/mp2t';
            } catch (e2) {
                return res.status(502).send('Segment fetch failed');
            }
        }
        if (ct.includes('mpegurl') || ct.includes('vnd.apple') || isPlaylist) {
            let body = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
            body = rewriteM3U8(body, url, proxyBase(req));
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(body);
        } else {
            if (!isPlaylist) segCacheSet(url, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), ct: ct || 'video/mp2t' });
            res.set('Content-Type', ct || 'video/mp2t');
            res.send(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }
    } catch (e) { console.error('Segment error:', e.message); res.status(500).send(e.message); }
});

app.get('/health', (_r, res) => res.json({ ok: true }));
app.get('/', (_r, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 7002;
app.listen(PORT, () => console.log(`http://localhost:${PORT}/`));
