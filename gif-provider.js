/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Provider-independent GIF search. A free, keyless provider (urGIF) is used by
   default; Tenor/GIPHY can be configured with GIF_PROVIDER + GIF_API_KEY.
   No keys are hardcoded and no media is downloaded or cached by the server. */
'use strict';

const PROVIDER = (process.env.GIF_PROVIDER || 'urgif').toLowerCase();
const API_KEY = process.env.GIF_API_KEY || '';

function configured() {
  if (PROVIDER === 'urgif') return true;
  return !!(API_KEY && (PROVIDER === 'tenor' || PROVIDER === 'giphy'));
}

function normaliseUrgif(item) {
  return {
    id: String(item.id || ''),
    url: item.url || '',
    previewUrl: item.url || '',
    staticUrl: '',
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    alt: (Array.isArray(item.tags) && item.tags.length ? item.tags.join(', ') : String(item.id || 'GIF')).slice(0, 80),
  };
}

function normaliseTenor(item) {
  const formats = item.media_formats || {};
  const gif = formats.gif || formats.mediumgif || formats.tinygif || {};
  const tiny = formats.tinygif || gif;
  return {
    id: String(item.id || ''),
    url: gif.url || '',
    previewUrl: tiny.url || gif.url || '',
    staticUrl: '',
    width: gif.dims ? gif.dims[0] : 0,
    height: gif.dims ? gif.dims[1] : 0,
    alt: (item.content_description || 'GIF').slice(0, 80),
  };
}

function normaliseGiphy(item) {
  const images = item.images || {};
  const gif = images.downsized || images.original || {};
  const small = images.fixed_width_small || images.downsized_small || gif;
  return {
    id: String(item.id || ''),
    url: gif.url || '',
    previewUrl: small.url || gif.url || '',
    staticUrl: '',
    width: Number(gif.width) || 0,
    height: Number(gif.height) || 0,
    alt: (item.title || 'GIF').slice(0, 80),
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Provider returned ' + res.status);
  return res.json();
}

async function search(query) {
  if (!configured()) return { configured: false, results: [] };
  const q = String(query || '').trim().slice(0, 80);

  if (PROVIDER === 'urgif') {
    const params = new URLSearchParams({ limit: '16' });
    if (q) params.set('q', q);
    const data = await fetchJson(`https://api.urgif.com/v1/${q ? 'search' : 'trending'}?${params}`);
    return { configured: true, results: (data.data || []).map(normaliseUrgif).filter((r) => r.url) };
  }

  if (PROVIDER === 'tenor') {
    const path = q ? 'search' : 'trending';
    const params = new URLSearchParams({ key: API_KEY, limit: '16', media_filter: 'minimal' });
    if (q) params.set('q', q);
    const data = await fetchJson(`https://tenor.googleapis.com/v2/${path}?${params}`);
    return { configured: true, results: (data.results || []).map(normaliseTenor).filter((r) => r.url) };
  }

  const params = new URLSearchParams({ api_key: API_KEY, limit: '16' });
  if (q) params.set('q', q);
  const data = await fetchJson(`https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`);
  return { configured: true, results: (data.data || []).map(normaliseGiphy).filter((r) => r.url) };
}

module.exports = { configured, search, provider: PROVIDER };
